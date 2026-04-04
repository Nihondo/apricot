/**
 * Web interface module.
 * Provides an HTTP-based IRC chat interface similar to plum's imode module.
 *
 * Features:
 *   - Channel list page
 *   - Per-channel message view with send form
 *   - Auto-refresh (30s)
 *   - Full theme customization with preset restore
 *   - Message history with timestamps
 *   - IRC event logging (JOIN/PART/QUIT/NICK/TOPIC etc.)
 */

import { defineModule } from "../module-system";
import { extractNick, isChannel } from "../irc-parser";
import CSS from "../templates/style.css";
import ADMIN_CSS from "../templates/admin-style.css";
import CHANNEL_SHELL_TEMPLATE from "../templates/channel.html";
import CHANNEL_MESSAGES_TEMPLATE from "../templates/channel-messages.html";
import CHANNEL_COMPOSER_TEMPLATE from "../templates/channel-composer.html";
import CHANNEL_LIST_TEMPLATE from "../templates/channel-list.html";
import SETTINGS_TEMPLATE from "../templates/settings.html";
import {
  resolveMessageEmbed,
  type ResolvedUrlEmbed,
} from "./url-metadata";

// ---------------------------------------------------------------------------
// Message storage
// ---------------------------------------------------------------------------

export interface StoredMessage {
  time: number; // Unix ms
  type: "privmsg" | "notice" | "join" | "part" | "quit" | "kick" | "nick" | "topic" | "mode" | "self";
  nick: string;
  text: string;
  embed?: ResolvedUrlEmbed;
}

/**
 * JSON-serializable snapshot of per-channel web logs keyed by lowercase channel.
 */
export type PersistedWebLogs = Record<string, StoredMessage[]>;
export type WebDisplayOrder = "asc" | "desc";

export interface WebUiColorSettings {
  textColor: string;
  surfaceColor: string;
  surfaceAltColor: string;
  accentColor: string;
  borderColor: string;
  usernameColor: string;
  timestampColor: string;
  highlightColor: string;
  buttonColor: string;
  buttonTextColor: string;
  selfColor: string;
  mutedTextColor: string;
  keywordColor: string;
}

export interface WebUiSettings extends WebUiColorSettings {
  fontFamily: string;
  fontSizePx: number;
  displayOrder: WebDisplayOrder;
  extraCss: string;
  highlightKeywords: string;
  dimKeywords: string;
  enableInlineUrlPreview: boolean;
}

const DEFAULT_maxLines = 200;

export const LIGHT_WEB_UI_COLOR_PRESET: WebUiColorSettings = {
  textColor: "#000000",
  surfaceColor: "#FFFFFF",
  surfaceAltColor: "#EDF3FE",
  accentColor: "#0B5FFF",
  borderColor: "#0B5FFF",
  usernameColor: "#B00020",
  timestampColor: "#5E35B1",
  highlightColor: "#8A6D00",
  buttonColor: "#0B5FFF",
  buttonTextColor: "#FFFFFF",
  selfColor: "#2E7D32",
  mutedTextColor: "#75715E",
  keywordColor: "#D84315",
};

export const DARK_WEB_UI_COLOR_PRESET: WebUiColorSettings = {
  textColor: "#F8F8F2",
  surfaceColor: "#1F2023",
  surfaceAltColor: "#2A2B2E",
  accentColor: "#A6E22E",
  borderColor: "#2B8BF7",
  usernameColor: "#F92672",
  timestampColor: "#AE81FF",
  highlightColor: "#E6DB74",
  buttonColor: "#2B8BF7",
  buttonTextColor: "#FFFFFF",
  selfColor: "#66D9EF",
  mutedTextColor: "#75715E",
  keywordColor: "#FD971F",
};

export const DEFAULT_WEB_UI_SETTINGS: WebUiSettings = {
  fontFamily: "\"Hiragino Kaku Gothic ProN\", \"Noto Sans JP\", sans-serif",
  fontSizePx: 16,
  ...LIGHT_WEB_UI_COLOR_PRESET,
  displayOrder: "desc",
  extraCss: "",
  highlightKeywords: "",
  dimKeywords: "",
  enableInlineUrlPreview: false,
};

type MessageBufferStore = Map<string, StoredMessage[]>;
type PersistLogsCallback = (logs: PersistedWebLogs) => Promise<void>;
const WEB_UI_COLOR_FIELDS = [
  { name: "textColor", label: "文字色" },
  { name: "surfaceColor", label: "背景色1" },
  { name: "surfaceAltColor", label: "背景色2" },
  { name: "accentColor", label: "リンク" },
  { name: "highlightColor", label: "リンク行" },
  { name: "keywordColor", label: "キーワード" },
  { name: "timestampColor", label: "時刻" },
  { name: "selfColor", label: "自ユーザ名" },
  { name: "usernameColor", label: "他ユーザ名" },
  { name: "buttonColor", label: "ボタン" },
  { name: "buttonTextColor", label: "ボタン文字" },
  { name: "borderColor", label: "枠線" },
  { name: "mutedTextColor", label: "控えめ表示行" },
] as const satisfies ReadonlyArray<{ name: keyof WebUiColorSettings; label: string }>;

/** Minimal interface for channel membership lookup (avoids circular import) */
interface ChannelMembership {
  name: string;
  members: Set<string>;
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderColorValue(color: string): string {
  return color.toUpperCase();
}

function buildLinkBackgroundColor(accentColor: string): string {
  const red = Number.parseInt(accentColor.slice(1, 3), 16);
  const green = Number.parseInt(accentColor.slice(3, 5), 16);
  const blue = Number.parseInt(accentColor.slice(5, 7), 16);
  return `rgba(${red},${green},${blue},0.2)`;
}

function renderSettingsError(errorMessage: string): string {
  return errorMessage
    ? `<div class="admin-message admin-message--danger" role="alert"><strong>設定を保存できませんでした。</strong><span>${escapeHtml(errorMessage)}</span></div>`
    : "";
}

function renderFlashMessage(message: string, tone: "info" | "danger"): string {
  return message
    ? `<div class="admin-message admin-message--${tone}" role="alert"><span>${escapeHtml(message)}</span></div>`
    : "";
}

function renderAdminLogoutForm(basePath: string): string {
  return `<form action="${basePath}/logout" method="POST"><button type="submit" class="admin-button admin-button--subtle">ログアウト</button></form>`;
}

/**
 * Returns a cloned settings object with missing fields filled from defaults.
 */
export function buildWebUiSettings(
  overrides?: Partial<WebUiSettings> | null
): WebUiSettings {
  return {
    ...DEFAULT_WEB_UI_SETTINGS,
    ...overrides,
  };
}

/**
 * Returns true when the provided value is a valid message display order.
 */
export function isWebDisplayOrder(value: string): value is WebDisplayOrder {
  return value === "asc" || value === "desc";
}

/**
 * Builds the fixed admin UI CSS injected into non-channel Web UI pages.
 */
export function buildAdminCss(): string {
  return ADMIN_CSS;
}

/**
 * Builds the CSS string injected into the channel page.
 */
export function buildChannelCss(settings: WebUiSettings): string {
  const rootLines = [
    `--rowcolor0: ${settings.surfaceColor};`,
    `--rowcolor1: ${settings.surfaceAltColor};`,
    `--textcolor: ${settings.textColor};`,
    `--accent-link: ${settings.accentColor};`,
    `--link-bg: ${buildLinkBackgroundColor(settings.accentColor)};`,
    `--border-color: ${settings.borderColor};`,
    `--accent-username: ${settings.usernameColor};`,
    `--accent-timestamp: ${settings.timestampColor};`,
    `--accent-highlight: ${settings.highlightColor};`,
    `--button-bg: ${settings.buttonColor};`,
    `--button-fg: ${settings.buttonTextColor};`,
    `--accent-self: ${settings.selfColor};`,
    `--text-contrast-low: ${settings.mutedTextColor};`,
    `--accent-keyword: ${settings.keywordColor};`,
  ];
  const typographyLines = [
    `font-family: ${settings.fontFamily};`,
    `font-size: ${settings.fontSizePx}px;`,
  ];
  const blocks = [
    `:root {\n  ${rootLines.join("\n  ")}\n}`,
    `body,\ninput,\nbutton,\ntextarea {\n  ${typographyLines.join("\n  ")}\n}`,
  ];
  const extraCss = settings.extraCss.trim();
  return [CSS, ...blocks, extraCss].filter(Boolean).join("\n\n");
}

function renderThemeColorFields(webUiSettings: WebUiSettings): string {
  return WEB_UI_COLOR_FIELDS.map(({ name, label }) => (
    `<label class="admin-field">
      <span class="admin-field__label">${label}</span>
      <input type="color" name="${name}" value="${renderColorValue(webUiSettings[name])}" class="admin-input admin-input--color" data-theme-color="${name}">
    </label>`
  )).join("\n");
}

function renderThemePresetControls(): string {
  return `<div class="admin-message admin-message--info" style="display:flex; align-items: center;"><strong>配色プリセット</strong>
<div class="admin-form__actions" style="margin-left: auto;">
  <button type="button" class="admin-button admin-button--subtle" data-theme-preset="light">ライト</button>
  <button type="button" class="admin-button admin-button--subtle" data-theme-preset="dark">ダーク</button>
</div>
</div>`;
}

function renderThemePresetScript(): string {
  const lightPreset = JSON.stringify(LIGHT_WEB_UI_COLOR_PRESET);
  const darkPreset = JSON.stringify(DARK_WEB_UI_COLOR_PRESET);

  return `<script>
window.addEventListener("DOMContentLoaded", function () {
  var presets = {
    light: ${lightPreset},
    dark: ${darkPreset}
  };
  var presetButtons = document.querySelectorAll("[data-theme-preset]");
  presetButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var presetName = button.getAttribute("data-theme-preset");
      if (!presetName || !presets[presetName]) {
        return;
      }
      var preset = presets[presetName];
      Object.keys(preset).forEach(function (fieldName) {
        var input = document.querySelector('[data-theme-color="' + fieldName + '"]');
        if (input) {
          input.value = preset[fieldName];
        }
      });
    });
  });
});
</script>`;
}

/**
 * Parses a newline/comma-separated keyword string into a list of trimmed, non-empty keywords.
 */
function parseKeywords(raw: string): string[] {
  return raw.split(/[\n,]/).map((k) => k.trim()).filter((k) => k.length > 0);
}

function renderEmbedDataAttributes(embed: ResolvedUrlEmbed): string {
  const attrs = [
    `data-preview-kind="${escapeHtml(embed.kind)}"`,
    `data-preview-source-url="${escapeHtml(embed.sourceUrl)}"`,
  ];
  if (embed.imageUrl) {
    attrs.push(`data-preview-image-url="${escapeHtml(embed.imageUrl)}"`);
  }
  if (embed.title) {
    attrs.push(`data-preview-title="${escapeHtml(embed.title)}"`);
  }
  if (embed.siteName) {
    attrs.push(`data-preview-site-name="${escapeHtml(embed.siteName)}"`);
  }
  if (embed.description) {
    attrs.push(`data-preview-description="${escapeHtml(embed.description)}"`);
  }
  return attrs.join(" ");
}

function renderUrlEmbed(embed: ResolvedUrlEmbed, variant: "inline" | "popup"): string {
  const baseClass = variant === "inline" ? "url-embed url-embed--inline" : "url-embed url-embed--popup";
  const embedClass = embed.imageUrl ? baseClass : `${baseClass} url-embed--text-only`;
  const imageClass = embed.kind === "image" ? "url-embed__image url-embed__image--full" : "url-embed__image";
  const siteNameHtml = embed.siteName
    ? `<span class="url-embed__site">${escapeHtml(embed.siteName)}</span>`
    : "";
  const titleHtml = embed.title
    ? `<span class="url-embed__title">${escapeHtml(embed.title)}</span>`
    : "";
  const descriptionHtml = embed.description
    ? `<span class="url-embed__description">${escapeHtml(embed.description)}</span>`
    : "";
  const metaHtml = siteNameHtml || titleHtml || descriptionHtml
    ? `<span class="url-embed__meta">${siteNameHtml}${titleHtml}${descriptionHtml}</span>`
    : "";
  const imageHtml = embed.imageUrl
    ? `<img src="${escapeHtml(embed.imageUrl)}" alt="${embed.title ? escapeHtml(embed.title) : "URL preview"}" class="${imageClass}" loading="lazy">`
    : "";

  return `<a href="${escapeHtml(embed.sourceUrl)}" target="_blank" rel="noopener" class="${embedClass}">
    ${imageHtml}
    ${metaHtml}
  </a>`;
}

function buildPreviewScript(): string {
  return `var popup = document.getElementById("url-preview-popup");
if (popup) {
  var popupEmbed = popup.querySelector("[data-preview-popup-embed]");
  var popupImage = popup.querySelector("[data-preview-popup-image]");
  var popupSite = popup.querySelector("[data-preview-popup-site]");
  var popupTitle = popup.querySelector("[data-preview-popup-title]");
  var popupDescription = popup.querySelector("[data-preview-popup-description]");
  var hoverCapable = window.matchMedia && window.matchMedia("(hover: hover)").matches;
  var longPressTimer = 0;
  var longPressHandled = false;
  var activeLink = null;

  function fillPopup(link) {
    if (!popupEmbed || !popupImage || !popupSite || !popupTitle || !popupDescription) {
      return;
    }
    var hasPreviewImage = Boolean(link.dataset.previewImageUrl);
    popupImage.hidden = !hasPreviewImage;
    if (hasPreviewImage) {
      popupImage.setAttribute("src", link.dataset.previewImageUrl || "");
      popupImage.setAttribute("alt", link.dataset.previewTitle || "URL preview");
      popupImage.className = link.dataset.previewKind === "image"
        ? "url-embed__image url-embed__image--full"
        : "url-embed__image";
    } else {
      popupImage.removeAttribute("src");
      popupImage.setAttribute("alt", "URL preview");
      popupImage.className = "url-embed__image";
    }
    popupSite.textContent = link.dataset.previewSiteName || "";
    popupTitle.textContent = link.dataset.previewTitle || "";
    popupDescription.textContent = link.dataset.previewDescription || "";
    popupDescription.hidden = !link.dataset.previewDescription;
    popupEmbed.classList.toggle("url-embed--text-only", !hasPreviewImage);
    popup.classList.toggle("url-preview-popup--card", link.dataset.previewKind !== "image" || !hasPreviewImage);
  }

  function positionPopup(link) {
    var rect = link.getBoundingClientRect();
    popup.style.left = "0px";
    popup.style.top = "0px";
    popup.hidden = false;
    var popupRect = popup.getBoundingClientRect();
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8));
    var top = rect.bottom + 8;
    if (top + popupRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - popupRect.height - 8);
    }
    popup.style.left = left + "px";
    popup.style.top = top + "px";
  }

  function showPopup(link) {
    activeLink = link;
    fillPopup(link);
    positionPopup(link);
  }

  function hidePopup() {
    activeLink = null;
    popup.hidden = true;
  }

  function clearLongPressTimer() {
    if (longPressTimer) {
      window.clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  }

  var links = document.querySelectorAll("a[data-preview-kind]");
  links.forEach(function (link) {
    if (hoverCapable) {
      link.addEventListener("mouseenter", function () {
        showPopup(link);
      });
      link.addEventListener("mouseleave", function () {
        if (activeLink === link) {
          hidePopup();
        }
      });
    }

    link.addEventListener("focus", function () {
      showPopup(link);
    });
    link.addEventListener("blur", function () {
      if (activeLink === link) {
        hidePopup();
      }
    });

    link.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "mouse") {
        return;
      }
      longPressHandled = false;
      clearLongPressTimer();
      longPressTimer = window.setTimeout(function () {
        longPressHandled = true;
        showPopup(link);
      }, 450);
    });

    link.addEventListener("pointerup", clearLongPressTimer);
    link.addEventListener("pointercancel", clearLongPressTimer);
    link.addEventListener("pointermove", clearLongPressTimer);
    link.addEventListener("click", function (event) {
      if (longPressHandled) {
        event.preventDefault();
        longPressHandled = false;
      }
    });
  });

  document.addEventListener("pointerdown", function (event) {
    if (!(event.target instanceof Element)) {
      return;
    }
    if (popup.contains(event.target)) {
      return;
    }
    if (event.target.closest("a[data-preview-kind]")) {
      return;
    }
    hidePopup();
  });

  window.addEventListener("scroll", hidePopup, { passive: true });
  window.addEventListener("resize", hidePopup);
}`;
}

function buildConditionalAutoScrollScript(channel: string): string {
  const storageKey = JSON.stringify(`apricot:scroll-stick:${channel.toLowerCase()}`);
  return `var nearBottomThreshold = 48;
var scrollStateStorageKey = ${storageKey};

function getScrollRoot() {
  return document.scrollingElement || document.documentElement;
}

function scrollToBottom() {
  var root = getScrollRoot();
  window.scrollTo(0, root.scrollHeight);
}

function isNearBottom() {
  var root = getScrollRoot();
  return root.scrollHeight - root.clientHeight - root.scrollTop <= nearBottomThreshold;
}

function readShouldStickToBottom() {
  try {
    return window.sessionStorage.getItem(scrollStateStorageKey) === "1";
  } catch {
    return false;
  }
}

function writeShouldStickToBottom(shouldStickToBottom) {
  try {
    window.sessionStorage.setItem(scrollStateStorageKey, shouldStickToBottom ? "1" : "0");
  } catch {}
}

function scheduleBottomStick() {
  scrollToBottom();
  window.requestAnimationFrame(function () {
    scrollToBottom();
    window.requestAnimationFrame(scrollToBottom);
  });
  window.setTimeout(scrollToBottom, 120);
}

var shouldStickToBottom = readShouldStickToBottom();
if (shouldStickToBottom) {
  scheduleBottomStick();
  document.querySelectorAll("img").forEach(function (image) {
    if (image.complete) {
      return;
    }
    image.addEventListener("load", scrollToBottom, { once: true });
  });
}

window.addEventListener("beforeunload", function () {
  writeShouldStickToBottom(isNearBottom());
});`;
}

function buildComposerOnLoadScript(shouldReloadMessages: boolean): string {
  const scriptLines = [
    "function preventComposerScroll(event) {",
    "  event.preventDefault();",
    "}",
    'window.addEventListener("wheel", preventComposerScroll, { passive: false });',
    'window.addEventListener("touchmove", preventComposerScroll, { passive: false });',
  ];

  if (shouldReloadMessages) {
    scriptLines.push(
      'var frame = window.parent && window.parent.document.getElementById("channel-messages-frame");',
      "if (frame && frame.contentWindow) {",
      "  frame.contentWindow.location.reload();",
      "}"
    );
  }

  return scriptLines.join("\n");
}

/**
 * Escape text for HTML, linkifying any URLs found in the raw string.
 * Also wraps any matched highlightKeywords in <span class="keyword-hl">.
 *
 * URLs are extracted from the raw (unescaped) text first, so the href
 * attribute contains the real URL (not &amp;-encoded).  The surrounding
 * non-URL text and the link label are then HTML-escaped safely.
 */
function renderText(
  raw: string,
  highlightKeywords: string[] = [],
  embed?: ResolvedUrlEmbed,
  enablePopupPreview = false,
): string {
  const urlRe = /(https?:\/\/[^\s<>"]+)/g;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = urlRe.exec(raw)) !== null) {
    result += escapeHtml(raw.slice(last, m.index));
    const url = m[1];
    let hostname: string;
    try { hostname = new URL(url).hostname; } catch { hostname = url; }
    const previewAttrs = enablePopupPreview && embed?.sourceUrl === url
      ? ` class="url-link url-link--preview" ${renderEmbedDataAttributes(embed)}`
      : ' class="url-link"';
    result += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"${previewAttrs}>${escapeHtml(hostname)}</a>`;
    last = m.index + url.length;
  }
  result += escapeHtml(raw.slice(last));

  if (highlightKeywords.length === 0) {
    return result;
  }

  // Wrap keyword matches in non-anchor text segments only.
  const escaped = highlightKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const kwRe = new RegExp(`(${escaped.join("|")})`, "gi");
  return result.replace(/(<a [^>]*>.*?<\/a>)|([^<]+)/g, (_, anchor, text) => {
    if (anchor) return anchor;
    return text.replace(kwRe, '<span class="keyword-hl">$1</span>');
  });
}

function formatTime(ms: number, offsetHours: number): string {
  const d = new Date(ms + offsetHours * 3_600_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function renderMessage(
  m: StoredMessage,
  selfNick: string,
  offsetHours: number,
  highlightKeywords: string[] = [],
  webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
): string {
  const ts = `<span class="timestamp">${formatTime(m.time, offsetHours)}</span>`;
  const isSelf = m.nick.toLowerCase() === selfNick.toLowerCase();
  const nickClass = isSelf ? "username-self" : "username-other";
  const canUsePopupPreview = !webUiSettings.enableInlineUrlPreview && Boolean(m.embed);
  const inlineEmbedHtml = webUiSettings.enableInlineUrlPreview && m.embed
      ? `<div class="url-embed-container">${renderUrlEmbed(m.embed, "inline")}</div>`
      : "";

  switch (m.type) {
    case "privmsg":
      return `${ts} <span class="${nickClass}">${escapeHtml(m.nick)}&gt;</span> ${renderText(m.text, highlightKeywords, m.embed, canUsePopupPreview)}${inlineEmbedHtml}`;
    case "notice":
      return `${ts} <span class="${nickClass}">(${escapeHtml(m.nick)})</span> ${renderText(m.text, highlightKeywords, m.embed, canUsePopupPreview)}${inlineEmbedHtml}`;
    case "self":
      return `${ts} <span class="username-self">${escapeHtml(m.nick)}&gt;</span> ${renderText(m.text, highlightKeywords, m.embed, canUsePopupPreview)}${inlineEmbedHtml}`;
    case "join":
      return `${ts} <span class="timestamp">*** ${escapeHtml(m.nick)} has joined ${escapeHtml(m.text)}</span>`;
    case "part":
      return `${ts} <span class="timestamp">*** ${escapeHtml(m.nick)} has left ${escapeHtml(m.text)}</span>`;
    case "quit":
      return `${ts} <span class="timestamp">*** ${escapeHtml(m.nick)} has quit (${escapeHtml(m.text)})</span>`;
    case "kick":
      return `${ts} <span class="timestamp">*** ${escapeHtml(m.text)}</span>`;
    case "nick":
      return `${ts} <span class="timestamp">*** ${escapeHtml(m.nick)} is now known as ${escapeHtml(m.text)}</span>`;
    case "topic":
      return `${ts} <span class="timestamp">*** ${escapeHtml(m.nick)} changed topic to: ${escapeHtml(m.text)}</span>`;
    case "mode":
      return `${ts} <span class="timestamp">*** ${escapeHtml(m.nick)} sets mode ${escapeHtml(m.text)}</span>`;
    default:
      return `${ts} ${renderText(m.text, highlightKeywords, m.embed, canUsePopupPreview)}${inlineEmbedHtml}`;
  }
}

// ---------------------------------------------------------------------------
// Page builders
// ---------------------------------------------------------------------------

/** Pure function — no store needed */
export function buildChannelListPage(
  channels: string[],
  nick: string,
  serverName: string,
  connected: boolean,
  basePath: string,
  showLogout = false,
  showSettings = false,
  flashMessage = "",
  flashTone: "info" | "danger" = "info",
): string {
  const flashHtml = renderFlashMessage(flashMessage, flashTone);
  const nickForm = `
<form action="${basePath}/nick" method="POST" class="admin-inline-form">
  <label class="admin-field">
    <input type="text" name="nick" value="${escapeHtml(nick)}" class="admin-input" autocomplete="nickname">
  </label>
  <button type="submit" class="admin-button admin-button--subtle">NICK変更</button>
</form>`;
  const joinForm = `
<form action="${basePath}/join" method="POST" class="admin-inline-form">
  <input type="text" name="channel" placeholder="#channel" class="admin-input" autocomplete="off">
  <button type="submit" class="admin-button admin-button--primary">チャンネルに参加</button>
</form>`;
  const chLinks = (channels.length === 0
    ? `<div class="admin-empty-state"><h3>参加中のチャンネルはありません</h3><p>JOIN 済みチャンネルはここに表示されます。下のフォームから参加できます。</p></div>`
    : channels
        .map((ch) => `
<div class="admin-list-item">
  <a href="${basePath}/${encodeURIComponent(ch)}" class="admin-list-item__link">
    <span class="admin-list-item__title">${escapeHtml(ch)}</span>
    <span class="admin-list-item__meta">チャンネル画面を開く</span>
  </a>
  <form action="${basePath}/leave" method="POST">
    <input type="hidden" name="channel" value="${escapeHtml(ch)}">
    <button type="submit" class="admin-button admin-button--danger">チャンネルから離脱</button>
  </form>
</div>`)
        .join("\n")) + `\n${joinForm}`;
  const actionParts: string[] = [];
  if (showSettings) {
    actionParts.push(`<a href="${basePath}/settings" class="admin-button admin-button--subtle">設定</a>`);
  }
  if (showLogout) {
    actionParts.push(renderAdminLogoutForm(basePath));
  }
  const statusClass = connected ? "admin-status-badge--success" : "admin-status-badge--danger";
  const statusText = connected ? "接続中" : "切断中";
  const channelCountText = channels.length === 0
    ? "参加中チャンネルはありません"
    : `${channels.length} 件のチャンネルに参加中`;

  return CHANNEL_LIST_TEMPLATE
    .replace("{{CSS}}", buildAdminCss())
    .replace("{{STATUS_CLASS}}", statusClass)
    .replace("{{STATUS_TEXT}}", statusText)
    .replace("{{STATUS_ICON}}", connected ? "&#x1f7e2;" : "&#x1f534;")
    .split("{{NICK}}").join(escapeHtml(nick))
    .split("{{SERVER_NAME}}").join(escapeHtml(serverName))
    .replace("{{CHANNEL_COUNT}}", escapeHtml(channelCountText))
    .replace("{{TOP_ACTIONS}}", actionParts.join(""))
    .replace("{{FLASH_MESSAGE}}", flashHtml)
    .replace("{{NICK_FORM}}", nickForm)
    .replace("{{CHANNEL_LINKS}}", chLinks);
}

/**
 * Builds the settings page HTML for the Web UI.
 */
export function buildSettingsPage(
  nick: string,
  serverName: string,
  basePath: string,
  webUiSettings: WebUiSettings,
  errorMessage = ""
): string {
  const isAscendingOrder = webUiSettings.displayOrder === "asc";
  const topActionsHtml = `<a href="${basePath}/" class="admin-button admin-button--subtle">チャンネル一覧へ戻る</a>${renderAdminLogoutForm(basePath)}`;
  const errorHtml = renderSettingsError(errorMessage);
  const colorFieldsHtml = renderThemeColorFields(webUiSettings);
  const presetControlsHtml = renderThemePresetControls();
  const settingsScript = renderThemePresetScript();

  return SETTINGS_TEMPLATE
    .replace("{{CSS}}", buildAdminCss())
    .replace("{{NICK}}", escapeHtml(nick))
    .replace("{{SERVER_NAME}}", escapeHtml(serverName))
    .replace("{{TOP_ACTIONS}}", topActionsHtml)
    .replace("{{ERROR}}", errorHtml)
    .replace("{{ACTION_URL}}", `${basePath}/settings`)
    .replace("{{PRESET_CONTROLS}}", presetControlsHtml)
    .replace("{{FONT_FAMILY}}", escapeHtml(webUiSettings.fontFamily))
    .replace("{{FONT_SIZE_PX}}", String(webUiSettings.fontSizePx))
    .replace("{{COLOR_FIELDS}}", colorFieldsHtml)
    .replace("{{DISPLAY_ORDER_ASC_CHECKED}}", isAscendingOrder ? "checked" : "")
    .replace("{{DISPLAY_ORDER_DESC_CHECKED}}", isAscendingOrder ? "" : "checked")
    .replace("{{ENABLE_INLINE_URL_PREVIEW_CHECKED}}", webUiSettings.enableInlineUrlPreview ? "checked" : "")
    .replace("{{EXTRA_CSS}}", escapeHtml(webUiSettings.extraCss))
    .replace("{{HIGHLIGHT_KEYWORDS}}", escapeHtml(webUiSettings.highlightKeywords))
    .replace("{{DIM_KEYWORDS}}", escapeHtml(webUiSettings.dimKeywords))
    .replace("{{SETTINGS_SCRIPT}}", settingsScript);
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

/**
 * Create the web interface module.
 * The channelStates map is used to determine which channels a quitting user
 * was in (must run before channelTrackModule to see the membership).
 */
export function createWebModule(
  channelStates: Map<string, ChannelMembership>,
  timezoneOffset = 0,
  persistLogs?: PersistLogsCallback,
  maxLines = DEFAULT_maxLines
) {
  const store: MessageBufferStore = new Map();

  function getBuffer(channel: string): StoredMessage[] {
    const key = channel.toLowerCase();
    let buf = store.get(key);
    if (!buf) {
      buf = [];
      store.set(key, buf);
    }
    return buf;
  }

  function pushMessage(channel: string, msg: StoredMessage): void {
    const buf = getBuffer(channel);
    buf.push(msg);
    if (buf.length > maxLines) {
      buf.splice(0, buf.length - maxLines);
    }
  }

  async function persistSnapshot(): Promise<void> {
    if (!persistLogs) return;
    await persistLogs(snapshotLogs());
  }

  async function appendMessage(channel: string, msg: StoredMessage): Promise<void> {
    pushMessage(channel, msg);
    await persistSnapshot();
  }

  async function appendMessages(entries: Array<[string, StoredMessage]>): Promise<void> {
    if (entries.length === 0) return;
    for (const [channel, msg] of entries) {
      pushMessage(channel, msg);
    }
    await persistSnapshot();
  }

  async function buildTextMessage(
    type: "privmsg" | "notice" | "self",
    nick: string,
    text: string,
    embed?: ResolvedUrlEmbed,
  ): Promise<StoredMessage> {
    return {
      time: Date.now(),
      type,
      nick,
      text,
      embed: embed ?? await resolveMessageEmbed(text),
    };
  }

  const module = defineModule("web", (m) => {
    m.on("ss_privmsg", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      const text = msg.params[1] || "";
      const channel = isChannel(target) ? target : nick; // DM keyed by sender nick
      await appendMessage(channel, await buildTextMessage("privmsg", nick, text));
      return msg;
    });

    m.on("ss_notice", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      const text = msg.params[1] || "";
      const channel = isChannel(target) ? target : nick;
      await appendMessage(channel, await buildTextMessage("notice", nick, text));
      return msg;
    });

    m.on("ss_join", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const channel = msg.params[0];
      await appendMessage(channel, { time: Date.now(), type: "join", nick, text: channel });
      return msg;
    });

    m.on("ss_part", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const channel = msg.params[0];
      const reason = msg.params[1] || "";
      await appendMessage(channel, { time: Date.now(), type: "part", nick, text: reason || channel });
      return msg;
    });

    m.on("ss_quit", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const reason = msg.params[0] || "";
      const entries: Array<[string, StoredMessage]> = [];
      // Log quit only to channels the user was actually in.
      // This runs BEFORE channelTrackModule, so membership is still intact.
      for (const [, state] of channelStates) {
        if (state.members.has(nick)) {
          entries.push([state.name, { time: Date.now(), type: "quit", nick, text: reason }]);
        }
      }
      await appendMessages(entries);
      return msg;
    });

    m.on("ss_kick", async (_ctx, msg) => {
      const kicker = msg.prefix ? extractNick(msg.prefix) : "?";
      const channel = msg.params[0];
      const kicked = msg.params[1];
      const reason = msg.params[2] || "";
      await appendMessage(channel, {
        time: Date.now(),
        type: "kick",
        nick: kicker,
        text: `${kicker} kicked ${kicked} from ${channel} (${reason})`,
      });
      return msg;
    });

    m.on("ss_nick", async (_ctx, msg) => {
      const oldNick = msg.prefix ? extractNick(msg.prefix) : "?";
      const newNick = msg.params[0];
      const entries: Array<[string, StoredMessage]> = [];
      for (const [, state] of channelStates) {
        if (state.members.has(oldNick)) {
          entries.push([state.name, { time: Date.now(), type: "nick", nick: oldNick, text: newNick }]);
        }
      }
      await appendMessages(entries);
      return msg;
    });

    m.on("ss_topic", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const channel = msg.params[0];
      const topic = msg.params[1] || "";
      await appendMessage(channel, { time: Date.now(), type: "topic", nick, text: topic });
      return msg;
    });

    m.on("ss_mode", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      if (isChannel(target)) {
        const modeStr = msg.params.slice(1).join(" ");
        await appendMessage(target, { time: Date.now(), type: "mode", nick, text: modeStr });
      }
      return msg;
    });
  });

  // ---------------------------------------------------------------------------
  // Public API returned with the module
  // ---------------------------------------------------------------------------

  function buildChannelPage(
    channel: string,
    topic: string,
    selfNick: string,
    basePath: string,
    showLogout = false,
    webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS
  ): string {
    const channelBasePath = `${basePath}/${encodeURIComponent(channel)}`;
    const messagesUrl = `${channelBasePath}/messages`;
    const composerUrl = `${channelBasePath}/composer`;
    const messagesFrameHtml = `<iframe id="channel-messages-frame" class="channel-frame channel-frame--messages" src="${messagesUrl}" title="${escapeHtml(channel)} messages"></iframe>`;
    const composerFrameHtml = `<iframe id="channel-composer-frame" class="channel-frame channel-frame--composer" src="${composerUrl}" title="${escapeHtml(channel)} composer"></iframe>`;
    const frameContent = webUiSettings.displayOrder === "asc"
      ? `${messagesFrameHtml}\n${composerFrameHtml}`
      : `${composerFrameHtml}\n${messagesFrameHtml}`;

    return CHANNEL_SHELL_TEMPLATE
      .replace("{{CSS}}", buildChannelCss(webUiSettings))
      .replace("{{CHANNEL}}", escapeHtml(channel))
      .replace("{{TOPIC}}", escapeHtml(topic))
      .replace("{{FRAME_CONTENT}}", frameContent);
  }

  function buildChannelMessagesPage(
    channel: string,
    topic: string,
    selfNick: string,
    webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS
  ): string {
    const buf = getBuffer(channel);
    const ordered = webUiSettings.displayOrder === "asc" ? [...buf] : [...buf].reverse();
    const hlKeywords = parseKeywords(webUiSettings.highlightKeywords);
    const dimKeywordList = parseKeywords(webUiSettings.dimKeywords);
    const lines = ordered
      .map((msg) => {
        const isDimmed = dimKeywordList.length > 0 &&
          dimKeywordList.some((kw) => msg.text.toLowerCase().includes(kw.toLowerCase()));
        const divAttrs = isDimmed ? ' class="msg-dimmed"' : "";
        return `<div${divAttrs}>${renderMessage(msg, selfNick, timezoneOffset, hlKeywords, webUiSettings)}</div>`;
      })
      .join("\n");
    const popupHtml = webUiSettings.enableInlineUrlPreview
      ? ""
      : `<div id="url-preview-popup" class="url-preview-popup" hidden>
  <div data-preview-popup-embed class="url-embed url-embed--popup">
    <img data-preview-popup-image src="" alt="URL preview" class="url-embed__image" loading="lazy">
    <span class="url-embed__meta">
      <span data-preview-popup-site class="url-embed__site"></span>
      <span data-preview-popup-title class="url-embed__title"></span>
      <span data-preview-popup-description class="url-embed__description"></span>
    </span>
  </div>
</div>`;
    const reloadButton = webUiSettings.displayOrder === "desc"
      ? '<button type="button" class="floating" onclick="location.reload();">再読込</button>'
      : "";
    const scriptParts: string[] = [];
    if (webUiSettings.displayOrder === "asc") {
      scriptParts.push(buildConditionalAutoScrollScript(channel));
    }
    if (!webUiSettings.enableInlineUrlPreview) {
      scriptParts.push(buildPreviewScript());
    }

    return CHANNEL_MESSAGES_TEMPLATE
      .replace("{{CSS}}", buildChannelCss(webUiSettings))
      .replace("{{CHANNEL}}", escapeHtml(channel))
      .replace("{{TOPIC}}", escapeHtml(topic))
      .replace("{{RELOAD_BUTTON}}", reloadButton)
      .replace("{{AUTO_SCROLL_SCRIPT}}", scriptParts.join("\n"))
      .replace("{{MESSAGES}}", lines + popupHtml);
  }

  function buildChannelComposerPage(
    channel: string,
    basePath: string,
    messageValue = "",
    flashMessage = "",
    flashTone: "info" | "danger" = "info",
    webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
    shouldReloadMessages = false
  ): string {
    const actionUrl = `${basePath}/${encodeURIComponent(channel)}/composer`;
    const channelListLink = `<a href="${basePath}/" target="_top" class="channel-list-link" aria-label="チャンネル一覧へ戻る" title="チャンネル一覧へ戻る">☰</a>`;
    const flashHtml = renderFlashMessage(flashMessage, flashTone);
    const onLoadScript = buildComposerOnLoadScript(shouldReloadMessages);

    return CHANNEL_COMPOSER_TEMPLATE
      .replace("{{CSS}}", buildChannelCss(webUiSettings))
      .replace("{{CHANNEL}}", escapeHtml(channel))
      .replace("{{ACTION_URL}}", actionUrl)
      .replace("{{CHANNEL_LIST_LINK}}", channelListLink)
      .replace("{{FLASH_MESSAGE}}", flashHtml)
      .replace("{{MESSAGE_VALUE}}", escapeHtml(messageValue))
      .replace("{{ON_LOAD_SCRIPT}}", onLoadScript);
  }

  /**
   * Adds a locally generated message and persists the latest snapshot.
   */
  async function recordSelfMessage(
    channel: string,
    nick: string,
    text: string,
    embed?: ResolvedUrlEmbed,
  ): Promise<void> {
    await appendMessage(channel, await buildTextMessage("self", nick, text, embed));
  }

  function getChannelTopic(channel: string): string {
    const buf = getBuffer(channel);
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].type === "topic") return buf[i].text;
    }
    return "";
  }

  /**
   * Returns a JSON-serializable snapshot of the current web log buffers.
   */
  function snapshotLogs(): PersistedWebLogs {
    return Object.fromEntries(
      Array.from(store.entries()).map(([channel, messages]) => [
        channel,
        messages.map((msg) => ({ ...msg })),
      ])
    );
  }

  /**
   * Restores web log buffers from a previously persisted snapshot.
   */
  function hydrateLogs(snapshot?: PersistedWebLogs | null): void {
    store.clear();
    if (!snapshot) return;

    for (const [channel, messages] of Object.entries(snapshot)) {
      const restored = messages.slice(-maxLines).map((msg) => ({ ...msg }));
      store.set(channel.toLowerCase(), restored);
    }
  }

  /**
   * Returns the stored messages for a single channel (lowercase key match).
   * Returns null if no buffer exists for that channel.
   */
  function getChannelLogs(channel: string): StoredMessage[] | null {
    const buf = store.get(channel.toLowerCase());
    return buf ? [...buf] : null;
  }

  return {
    module,
    buildChannelPage,
    buildChannelMessagesPage,
    buildChannelComposerPage,
    recordSelfMessage,
    getChannelTopic,
    snapshotLogs,
    hydrateLogs,
    getChannelLogs,
  };
}
