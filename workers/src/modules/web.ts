/**
 * Web interface module.
 * Provides an HTTP-based IRC chat interface similar to plum's imode module.
 *
 * Features:
 *   - Channel list page
 *   - Per-channel message view with send form
 *   - Fetch-based refresh with WebSocket notifications
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
import { sanitizeCustomCss } from "../custom-css";

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

const SETTINGS_PREVIEW_CHANNEL_NAME = "#preview";
const SETTINGS_PREVIEW_TOPIC = "配色プレビュー";
const SETTINGS_PREVIEW_MESSAGE_VALUE = "送信テキストの見本";
const SETTINGS_PREVIEW_SELF_NICK = "apricot";
const SETTINGS_PREVIEW_HIGHLIGHT_KEYWORDS = ["重要ワード"];
const SETTINGS_PREVIEW_DIM_KEYWORDS = ["log noise"];
const SETTINGS_PREVIEW_MESSAGES: ReadonlyArray<StoredMessage> = [
  {
    time: (9 * 60 + 41) * 60_000,
    type: "self",
    nick: SETTINGS_PREVIEW_SELF_NICK,
    text: "プレビュー表示を確認します",
  },
  {
    time: (9 * 60 + 42) * 60_000,
    type: "privmsg",
    nick: "alice",
    text: "資料は https://example.com/docs にあります",
  },
  {
    time: (9 * 60 + 43) * 60_000,
    type: "privmsg",
    nick: "bob",
    text: "重要ワード を含むメッセージです",
  },
  {
    time: (9 * 60 + 44) * 60_000,
    type: "notice",
    nick: "server",
    text: "log noise: バックグラウンド通知",
  },
] as const;

type MessageBufferStore = Map<string, StoredMessage[]>;
type PersistLogsCallback = (logs: PersistedWebLogs) => Promise<void>;
type ChannelLogsChangedCallback = (channels: string[]) => void;
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

function renderAdminBrand(logoUrl: string): string {
  return `<div class="admin-brand"><img src="${escapeHtml(logoUrl)}" alt="apricot" class="admin-brand__image" width="315" height="103"></div>`;
}

export function buildWebAppHead(basePath: string, themeColor: string, appTitle = "apricot"): string {
  const manifestUrl = `${basePath}/manifest.webmanifest`;
  const appIconUrl = `${basePath}/assets/app-icon.png`;
  return [
    `<link rel="manifest" href="${escapeHtml(manifestUrl)}">`,
    `<link rel="apple-touch-icon" href="${escapeHtml(appIconUrl)}">`,
    `<meta name="theme-color" content="${escapeHtml(themeColor)}">`,
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    `<meta name="apple-mobile-web-app-title" content="${escapeHtml(appTitle)}">`,
  ].join("\n");
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
  return [CSS, ...blocks].join("\n\n");
}

export function buildCustomThemeCss(settings: WebUiSettings): string {
  return settings.extraCss.trim();
}

export function sanitizeStoredCustomCss(extraCss: string): string {
  const result = sanitizeCustomCss(extraCss);
  return result.ok ? result.value : "";
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
  <button type="button" class="admin-button admin-button--subtle" data-theme-preset="light">Light</button>
  <button type="button" class="admin-button admin-button--subtle" data-theme-preset="dark">Dark</button>
</div>
</div>`;
}

function buildSettingsPreviewMessageEntries(webUiSettings: WebUiSettings): Array<{ html: string; isDimmed: boolean }> {
  return SETTINGS_PREVIEW_MESSAGES.map((message) => ({
    html: renderMessage(
      message,
      SETTINGS_PREVIEW_SELF_NICK,
      0,
      SETTINGS_PREVIEW_HIGHLIGHT_KEYWORDS,
      webUiSettings,
    ),
    isDimmed: SETTINGS_PREVIEW_DIM_KEYWORDS.some((keyword) =>
      message.text.toLowerCase().includes(keyword.toLowerCase())
    ),
  }));
}

function buildSettingsPreviewMessagesMarkup(webUiSettings: WebUiSettings): string {
  const lineEntries = buildSettingsPreviewMessageEntries(webUiSettings);
  const orderedEntries = webUiSettings.displayOrder === "asc"
    ? lineEntries
    : [...lineEntries].reverse();
  return orderedEntries
    .map((entry) => entry.isDimmed ? `<div class="msg-dimmed">${entry.html}</div>` : `<div>${entry.html}</div>`)
    .join("\n");
}

function buildSettingsPreviewMessagesDocument(webUiSettings: WebUiSettings): string {
  return [
    "<!DOCTYPE html>",
    "<html><head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, user-scalable=no">',
    `<title>IRC: ${escapeHtml(SETTINGS_PREVIEW_CHANNEL_NAME)} / ${escapeHtml(SETTINGS_PREVIEW_TOPIC)}</title>`,
    `<style>${buildChannelCss(webUiSettings)}</style>`,
    "</head>",
    '<body class="channel-messages-page">',
    `<div id="channel-messages-shell" class="channel-messages-shell">${buildSettingsPreviewMessagesMarkup(webUiSettings)}</div>`,
    "</body></html>",
  ].join("");
}

function buildSettingsPreviewComposerDocument(webUiSettings: WebUiSettings): string {
  return [
    "<!DOCTYPE html>",
    "<html><head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, user-scalable=no">',
    `<title>IRC: ${escapeHtml(SETTINGS_PREVIEW_CHANNEL_NAME)}/Composer</title>`,
    `<style>${buildChannelCss(webUiSettings)}</style>`,
    "</head>",
    '<body class="channel-composer-page">',
    '<div class="channel-composer-shell">',
    '<form action="#preview" method="POST" class="message-form">',
    '<a href="#preview" class="channel-list-link" aria-label="チャンネル一覧へ戻る" title="チャンネル一覧へ戻る">☰</a>',
    `<input type="text" name="message" size="10" value="${escapeHtml(SETTINGS_PREVIEW_MESSAGE_VALUE)}" class="message-input" autocomplete="off">`,
    '<input type="submit" value="送信" class="submit-button">',
    "</form>",
    "</div>",
    "</body></html>",
  ].join("");
}

function buildSettingsPreviewFrameHtml(
  kind: "messages" | "composer",
  title: string,
  documentHtml: string,
): string {
  return `<iframe class="channel-frame channel-frame--${kind}" title="${escapeHtml(title)}" sandbox srcdoc="${escapeIframeSrcdoc(documentHtml)}"></iframe>`;
}

function buildSettingsPreviewShellDocument(webUiSettings: WebUiSettings): string {
  const messagesFrameHtml = buildSettingsPreviewFrameHtml(
    "messages",
    "チャンネル表示プレビュー",
    buildSettingsPreviewMessagesDocument(webUiSettings),
  );
  const composerFrameHtml = buildSettingsPreviewFrameHtml(
    "composer",
    "送信フォームプレビュー",
    buildSettingsPreviewComposerDocument(webUiSettings),
  );
  const frameContent = webUiSettings.displayOrder === "asc"
    ? `${messagesFrameHtml}\n${composerFrameHtml}`
    : `${composerFrameHtml}\n${messagesFrameHtml}`;
  return CHANNEL_SHELL_TEMPLATE
    .replace("{{WEB_APP_HEAD}}", "")
    .replace("{{CSS}}", buildChannelCss(webUiSettings))
    .replace("{{THEME_CSS_LINK}}", "")
    .replace("{{CHANNEL}}", escapeHtml(SETTINGS_PREVIEW_CHANNEL_NAME))
    .replace("{{TOPIC}}", escapeHtml(SETTINGS_PREVIEW_TOPIC))
    .replace("{{FRAME_CONTENT}}", frameContent);
}

function escapeIframeSrcdoc(documentHtml: string): string {
  return escapeHtml(documentHtml);
}

function buildSettingsPreviewHtml(webUiSettings: WebUiSettings): string {
  return `<section class="theme-preview" data-theme-preview-root>
  <div class="theme-preview__header">
    <h3 class="theme-preview__title">表示プレビュー</h3>
    <p class="theme-preview__description">フォント、配色、表示順の変更結果を保存前に確認できます。</p>
  </div>
  <iframe
    class="theme-preview__frame"
    data-theme-preview-frame
    title="チャンネルシェルプレビュー"
    sandbox
    srcdoc="${escapeIframeSrcdoc(buildSettingsPreviewShellDocument(webUiSettings))}"
  ></iframe>
</section>`;
}

function renderThemePresetScript(): string {
  const lightPreset = JSON.stringify(LIGHT_WEB_UI_COLOR_PRESET);
  const darkPreset = JSON.stringify(DARK_WEB_UI_COLOR_PRESET);
  const colorFieldNames = JSON.stringify(WEB_UI_COLOR_FIELDS.map(({ name }) => name));
  const channelShellTemplate = JSON.stringify(CHANNEL_SHELL_TEMPLATE);
  const previewMessageEntries = JSON.stringify(buildSettingsPreviewMessageEntries(DEFAULT_WEB_UI_SETTINGS));
  const defaultPreviewSettings = JSON.stringify(DEFAULT_WEB_UI_SETTINGS);
  const channelBaseCss = JSON.stringify(CSS);
  const previewChannelName = JSON.stringify(SETTINGS_PREVIEW_CHANNEL_NAME);
  const previewTopic = JSON.stringify(SETTINGS_PREVIEW_TOPIC);
  const previewMessageValue = JSON.stringify(SETTINGS_PREVIEW_MESSAGE_VALUE);

  return `<script>
window.addEventListener("DOMContentLoaded", function () {
  var presets = {
    light: ${lightPreset},
    dark: ${darkPreset}
  };
  var colorFieldNames = ${colorFieldNames};
  var channelShellTemplate = ${channelShellTemplate};
  var previewMessageEntries = ${previewMessageEntries};
  var defaultPreviewSettings = ${defaultPreviewSettings};
  var channelBaseCss = ${channelBaseCss};
  var previewChannelName = ${previewChannelName};
  var previewTopic = ${previewTopic};
  var previewMessageValue = ${previewMessageValue};
  var presetButtons = document.querySelectorAll("[data-theme-preset]");
  var themePreviewUpdateScheduled = false;

  function buildPreviewChannelCss(settings) {
    var rootLines = [
      "--rowcolor0: " + settings.surfaceColor + ";",
      "--rowcolor1: " + settings.surfaceAltColor + ";",
      "--textcolor: " + settings.textColor + ";",
      "--accent-link: " + settings.accentColor + ";",
      "--link-bg: " + buildLinkBackgroundColor(settings.accentColor) + ";",
      "--border-color: " + settings.borderColor + ";",
      "--accent-username: " + settings.usernameColor + ";",
      "--accent-timestamp: " + settings.timestampColor + ";",
      "--accent-highlight: " + settings.highlightColor + ";",
      "--button-bg: " + settings.buttonColor + ";",
      "--button-fg: " + settings.buttonTextColor + ";",
      "--accent-self: " + settings.selfColor + ";",
      "--text-contrast-low: " + settings.mutedTextColor + ";",
      "--accent-keyword: " + settings.keywordColor + ";"
    ];
    var typographyLines = [
      "font-family: " + settings.fontFamily + ";",
      "font-size: " + settings.fontSizePx + "px;"
    ];
    return [
      channelBaseCss,
      ":root {\\n  " + rootLines.join("\\n  ") + "\\n}",
      "body,\\ninput,\\nbutton,\\ntextarea {\\n  " + typographyLines.join("\\n  ") + "\\n}"
    ].join("\\n\\n");
  }

  function buildLinkBackgroundColor(accentColor) {
    var red = Number.parseInt(accentColor.slice(1, 3), 16);
    var green = Number.parseInt(accentColor.slice(3, 5), 16);
    var blue = Number.parseInt(accentColor.slice(5, 7), 16);
    return "rgba(" + red + "," + green + "," + blue + ",0.2)";
  }

  function escapePreviewHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getPreviewSettings() {
    var settings = Object.assign({}, defaultPreviewSettings);
    var fontFamilyInput = document.querySelector('input[name="fontFamily"]');
    var fontSizeInput = document.querySelector('input[name="fontSizePx"]');
    var checkedDisplayOrder = document.querySelector('input[name="displayOrder"]:checked');

    settings.fontFamily = fontFamilyInput && fontFamilyInput.value.trim()
      ? fontFamilyInput.value
      : defaultPreviewSettings.fontFamily;
    settings.fontSizePx = fontSizeInput ? Number.parseInt(fontSizeInput.value || String(defaultPreviewSettings.fontSizePx), 10) : defaultPreviewSettings.fontSizePx;
    settings.displayOrder = checkedDisplayOrder ? checkedDisplayOrder.value : defaultPreviewSettings.displayOrder;
    if (!Number.isFinite(settings.fontSizePx)) {
      settings.fontSizePx = defaultPreviewSettings.fontSizePx;
    }

    colorFieldNames.forEach(function (fieldName) {
      var input = document.querySelector('[data-theme-color="' + fieldName + '"]');
      settings[fieldName] = input ? input.value : defaultPreviewSettings[fieldName];
    });

    return settings;
  }

  function buildPreviewMessagesMarkup(settings) {
    var orderedEntries = settings.displayOrder === "asc"
      ? previewMessageEntries.slice()
      : previewMessageEntries.slice().reverse();
    return orderedEntries.map(function (entry) {
      return entry.isDimmed
        ? '<div class="msg-dimmed">' + entry.html + "</div>"
        : "<div>" + entry.html + "</div>";
    }).join("\\n");
  }

  function buildPreviewMessagesDocument(settings) {
    return "<!DOCTYPE html><html><head>"
      + '<meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, user-scalable=no">'
      + "<title>IRC: " + escapePreviewHtml(previewChannelName) + " / " + escapePreviewHtml(previewTopic) + "</title>"
      + "<style>" + buildPreviewChannelCss(settings) + "</style>"
      + "</head><body class=\\"channel-messages-page\\">"
      + '<div id="channel-messages-shell" class="channel-messages-shell">' + buildPreviewMessagesMarkup(settings) + "</div>"
      + "</body></html>";
  }

  function buildPreviewComposerDocument(settings) {
    return "<!DOCTYPE html><html><head>"
      + '<meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, user-scalable=no">'
      + "<title>IRC: " + escapePreviewHtml(previewChannelName) + "/Composer</title>"
      + "<style>" + buildPreviewChannelCss(settings) + "</style>"
      + '</head><body class="channel-composer-page"><div class="channel-composer-shell">'
      + '<form action="#preview" method="POST" class="message-form">'
      + '<a href="#preview" class="channel-list-link" aria-label="チャンネル一覧へ戻る" title="チャンネル一覧へ戻る">☰</a>'
      + '<input type="text" name="message" size="10" value="' + escapePreviewHtml(previewMessageValue) + '" class="message-input" autocomplete="off">'
      + '<input type="submit" value="送信" class="submit-button">'
      + "</form></div></body></html>";
  }

  function buildPreviewFrameHtml(kind, title, documentHtml) {
    return '<iframe class="channel-frame channel-frame--' + kind + '" title="' + escapePreviewHtml(title) + '" sandbox srcdoc="' + escapePreviewHtml(documentHtml) + '"></iframe>';
  }

  function buildPreviewShellDocument(settings) {
    var messagesFrameHtml = buildPreviewFrameHtml("messages", "チャンネル表示プレビュー", buildPreviewMessagesDocument(settings));
    var composerFrameHtml = buildPreviewFrameHtml("composer", "送信フォームプレビュー", buildPreviewComposerDocument(settings));
    var frameContent = settings.displayOrder === "asc"
      ? messagesFrameHtml + "\\n" + composerFrameHtml
      : composerFrameHtml + "\\n" + messagesFrameHtml;
    return channelShellTemplate
      .replace("{{WEB_APP_HEAD}}", "")
      .replace("{{CSS}}", buildPreviewChannelCss(settings))
      .replace("{{THEME_CSS_LINK}}", "")
      .replace("{{CHANNEL}}", escapePreviewHtml(previewChannelName))
      .replace("{{TOPIC}}", escapePreviewHtml(previewTopic))
      .replace("{{FRAME_CONTENT}}", frameContent);
  }

  function updateThemePreview() {
    var settings = getPreviewSettings();
    var previewFrame = document.querySelector("[data-theme-preview-frame]");
    if (previewFrame) {
      previewFrame.srcdoc = buildPreviewShellDocument(settings);
    }
  }

  function scheduleThemePreviewUpdate() {
    if (themePreviewUpdateScheduled) {
      return;
    }
    themePreviewUpdateScheduled = true;
    window.requestAnimationFrame(function () {
      themePreviewUpdateScheduled = false;
      updateThemePreview();
    });
  }

  colorFieldNames.forEach(function (fieldName) {
    var input = document.querySelector('[data-theme-color="' + fieldName + '"]');
    if (!input) {
      return;
    }
    input.addEventListener("input", scheduleThemePreviewUpdate);
    input.addEventListener("change", scheduleThemePreviewUpdate);
  });

  [
    document.querySelector('input[name="fontFamily"]'),
    document.querySelector('input[name="fontSizePx"]'),
    document.querySelector('input[name="displayOrder"][value="asc"]'),
    document.querySelector('input[name="displayOrder"][value="desc"]')
  ].forEach(function (input) {
    if (!input) {
      return;
    }
    input.addEventListener("input", scheduleThemePreviewUpdate);
    input.addEventListener("change", scheduleThemePreviewUpdate);
  });

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
      scheduleThemePreviewUpdate();
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
  return `window.__apricotPreviewState = window.__apricotPreviewState || {
  initialized: false,
  activeLink: null,
  longPressTimer: 0,
  longPressHandled: false
};

window.initializeApricotPreview = window.initializeApricotPreview || function initializeApricotPreview() {
  var state = window.__apricotPreviewState;
  var hoverCapable = window.matchMedia && window.matchMedia("(hover: hover)").matches;

  function getPopup() {
    return document.getElementById("url-preview-popup");
  }

  function getPopupParts(popup) {
    if (!popup) {
      return null;
    }
    var popupEmbed = popup.querySelector("[data-preview-popup-embed]");
    var popupImage = popup.querySelector("[data-preview-popup-image]");
    var popupSite = popup.querySelector("[data-preview-popup-site]");
    var popupTitle = popup.querySelector("[data-preview-popup-title]");
    var popupDescription = popup.querySelector("[data-preview-popup-description]");
    if (!popupEmbed || !popupImage || !popupSite || !popupTitle || !popupDescription) {
      return null;
    }
    return {
      popup: popup,
      popupEmbed: popupEmbed,
      popupImage: popupImage,
      popupSite: popupSite,
      popupTitle: popupTitle,
      popupDescription: popupDescription
    };
  }

  function findPreviewLink(target) {
    return target instanceof Element ? target.closest("a[data-preview-kind]") : null;
  }

  function fillPopup(link) {
    var popupParts = getPopupParts(getPopup());
    if (!popupParts) {
      return false;
    }
    var hasPreviewImage = Boolean(link.dataset.previewImageUrl);
    popupParts.popupImage.hidden = !hasPreviewImage;
    if (hasPreviewImage) {
      popupParts.popupImage.setAttribute("src", link.dataset.previewImageUrl || "");
      popupParts.popupImage.setAttribute("alt", link.dataset.previewTitle || "URL preview");
      popupParts.popupImage.className = link.dataset.previewKind === "image"
        ? "url-embed__image url-embed__image--full"
        : "url-embed__image";
    } else {
      popupParts.popupImage.removeAttribute("src");
      popupParts.popupImage.setAttribute("alt", "URL preview");
      popupParts.popupImage.className = "url-embed__image";
    }
    popupParts.popupSite.textContent = link.dataset.previewSiteName || "";
    popupParts.popupTitle.textContent = link.dataset.previewTitle || "";
    popupParts.popupDescription.textContent = link.dataset.previewDescription || "";
    popupParts.popupDescription.hidden = !link.dataset.previewDescription;
    popupParts.popupEmbed.classList.toggle("url-embed--text-only", !hasPreviewImage);
    popupParts.popup.classList.toggle("url-preview-popup--card", link.dataset.previewKind !== "image" || !hasPreviewImage);
    return true;
  }

  function positionPopup(link) {
    var popup = getPopup();
    if (!popup) {
      return;
    }
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
    if (!fillPopup(link)) {
      return;
    }
    state.activeLink = link;
    positionPopup(link);
  }

  function hidePopup() {
    state.activeLink = null;
    var popup = getPopup();
    if (popup) {
      popup.hidden = true;
    }
  }

  function clearLongPressTimer() {
    if (state.longPressTimer) {
      window.clearTimeout(state.longPressTimer);
      state.longPressTimer = 0;
    }
  }

  if (state.initialized) {
    return;
  }
  state.initialized = true;

  document.addEventListener("mouseover", function (event) {
    if (!hoverCapable) {
      return;
    }
    var link = findPreviewLink(event.target);
    if (!link) {
      return;
    }
    var relatedLink = findPreviewLink(event.relatedTarget);
    if (relatedLink === link) {
      return;
    }
    showPopup(link);
  });

  document.addEventListener("mouseout", function (event) {
    if (!hoverCapable || !state.activeLink) {
      return;
    }
    var link = findPreviewLink(event.target);
    if (!link || link !== state.activeLink) {
      return;
    }
    var relatedLink = findPreviewLink(event.relatedTarget);
    if (relatedLink === link) {
      return;
    }
    hidePopup();
  });

  document.addEventListener("focusin", function (event) {
    var link = findPreviewLink(event.target);
    if (link) {
      showPopup(link);
    }
  });

  document.addEventListener("focusout", function (event) {
    var link = findPreviewLink(event.target);
    if (link && link === state.activeLink) {
      hidePopup();
    }
  });

  document.addEventListener("pointerdown", function (event) {
    var link = findPreviewLink(event.target);
    if (!link) {
      var popup = getPopup();
      if (popup && event.target instanceof Element && popup.contains(event.target)) {
        return;
      }
      hidePopup();
      return;
    }
    if (event.pointerType === "mouse") {
      return;
    }
    state.longPressHandled = false;
    clearLongPressTimer();
    state.longPressTimer = window.setTimeout(function () {
      state.longPressHandled = true;
      showPopup(link);
    }, 450);
  });

  document.addEventListener("pointerup", clearLongPressTimer);
  document.addEventListener("pointercancel", clearLongPressTimer);
  document.addEventListener("pointermove", clearLongPressTimer);
  document.addEventListener("click", function (event) {
    var link = findPreviewLink(event.target);
    if (!link) {
      return;
    }
    if (state.longPressHandled) {
      event.preventDefault();
      state.longPressHandled = false;
    }
  });

  window.addEventListener("scroll", hidePopup, { passive: true });
  window.addEventListener("resize", hidePopup);
};

window.initializeApricotPreview();`;
}

function buildConditionalAutoScrollScript(channel: string): string {
  const storageKey = JSON.stringify(`apricot:scroll-stick:${channel.toLowerCase()}`);
  return `window.apricotMessagesRuntime = window.apricotMessagesRuntime || {};
var nearBottomThreshold = 48;
var scrollStateStorageKey = ${storageKey};
var shouldStickToBottom = readShouldStickToBottom();

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

function setShouldStickToBottom(nextShouldStickToBottom) {
  shouldStickToBottom = Boolean(nextShouldStickToBottom);
  writeShouldStickToBottom(shouldStickToBottom);
  return shouldStickToBottom;
}

function updateShouldStickToBottom() {
  return setShouldStickToBottom(isNearBottom());
}

function stickToBottomIfNeeded() {
  if (!shouldStickToBottom) {
    return;
  }
  scrollToBottom();
}

function scheduleBottomStick() {
  setShouldStickToBottom(true);
  stickToBottomIfNeeded();
  window.requestAnimationFrame(function () {
    stickToBottomIfNeeded();
    window.requestAnimationFrame(stickToBottomIfNeeded);
  });
  window.setTimeout(stickToBottomIfNeeded, 120);
}

function bindPendingImages() {
  document.querySelectorAll("img").forEach(function (image) {
    if (image.complete) {
      return;
    }
    image.addEventListener("load", stickToBottomIfNeeded, { once: true });
  });
}

if (shouldStickToBottom) {
  scheduleBottomStick();
  bindPendingImages();
}

window.addEventListener("scroll", updateShouldStickToBottom, { passive: true });

window.addEventListener("beforeunload", function () {
  updateShouldStickToBottom();
});

window.apricotMessagesRuntime.getScrollRoot = getScrollRoot;
window.apricotMessagesRuntime.scrollToBottom = scrollToBottom;
window.apricotMessagesRuntime.isNearBottom = isNearBottom;
window.apricotMessagesRuntime.setShouldStickToBottom = setShouldStickToBottom;
window.apricotMessagesRuntime.updateShouldStickToBottom = updateShouldStickToBottom;
window.apricotMessagesRuntime.stickToBottomIfNeeded = stickToBottomIfNeeded;
window.apricotMessagesRuntime.scheduleBottomStick = scheduleBottomStick;
window.apricotMessagesRuntime.bindPendingImages = bindPendingImages;
window.apricotMessagesRuntime.writeShouldStickToBottom = writeShouldStickToBottom;`;
}

function buildChannelShellInitialStickScript(): string {
  return `<script>
(function () {
  var frame = document.getElementById("channel-messages-frame");
  if (!frame) {
    return;
  }

  function stickToLatestMessage() {
    try {
      var frameWindow = frame.contentWindow;
      var runtime = frameWindow && frameWindow.apricotMessagesRuntime;
      if (runtime && typeof runtime.scheduleBottomStick === "function") {
        runtime.scheduleBottomStick();
        if (typeof runtime.bindPendingImages === "function") {
          runtime.bindPendingImages();
        }
        return;
      }
      var frameDocument = frame.contentDocument;
      var root = frameDocument && (frameDocument.scrollingElement || frameDocument.documentElement);
      if (frameWindow && root) {
        frameWindow.scrollTo(0, root.scrollHeight);
      }
    } catch {}
  }

  frame.addEventListener("load", stickToLatestMessage);
  if (frame.contentDocument && frame.contentDocument.readyState === "complete") {
    stickToLatestMessage();
  }
})();
</script>`;
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
      "  if (typeof frame.contentWindow.refreshMessages === \"function\") {",
      "    void frame.contentWindow.refreshMessages();",
      "  } else {",
      "    frame.contentWindow.location.reload();",
      "  }",
      "}"
    );
  }

  return scriptLines.join("\n");
}

function buildMessagesPageScript(
  channel: string,
  webUiSettings: WebUiSettings,
  initialRevision = 0
): string {
  const serializedChannel = JSON.stringify(channel);
  const shouldAutoStick = webUiSettings.displayOrder === "asc";
  return `window.apricotMessagesRuntime = window.apricotMessagesRuntime || {};
var apricotUpdateChannel = ${serializedChannel};
var apricotNormalizedUpdateChannel = apricotUpdateChannel.toLowerCase();
var apricotShouldAutoStick = ${shouldAutoStick ? "true" : "false"};
var apricotRefreshInFlight = false;
var apricotRefreshQueued = false;
var apricotLatestRevision = ${initialRevision};
var apricotUpdateSocket = null;
var apricotReconnectDelayMs = 1000;
var apricotReconnectTimer = 0;
var apricotMaxReconnectDelayMs = 30000;
var apricotFallbackPollIntervalMs = 30000;
var apricotIsUnloading = false;

function getMessagesShell() {
  return document.getElementById("channel-messages-shell");
}

function getFragmentUrl() {
  return window.location.pathname.replace(/\\/messages\\/?$/, "/messages/fragment");
}

function getUpdatesUrl() {
  var path = window.location.pathname.replace(/\\/messages\\/?$/, "/updates");
  var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return protocol + "//" + window.location.host + path;
}

function updateKnownRevision(response) {
  var revision = Number(response.headers.get("X-Apricot-Channel-Revision") || "0");
  if (!Number.isFinite(revision) || revision <= 0) {
    return;
  }
  apricotLatestRevision = Math.max(apricotLatestRevision, revision);
}

function applyMessagesMarkup(html) {
  var shell = getMessagesShell();
  if (!shell) {
    return;
  }
  shell.innerHTML = html;
  if (typeof window.initializeApricotPreview === "function") {
    window.initializeApricotPreview();
  }
}

async function refreshMessages() {
  if (apricotRefreshInFlight) {
    apricotRefreshQueued = true;
    return;
  }

  apricotRefreshInFlight = true;
  var runtime = window.apricotMessagesRuntime || {};
  var shouldStickAfterRefresh = false;
  if (apricotShouldAutoStick) {
    if (typeof runtime.updateShouldStickToBottom === "function") {
      shouldStickAfterRefresh = runtime.updateShouldStickToBottom();
    } else if (typeof runtime.isNearBottom === "function") {
      shouldStickAfterRefresh = runtime.isNearBottom();
    }
  }

  try {
    var response = await fetch(getFragmentUrl(), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Requested-With": "apricot-fetch" }
    });
    if (!response.ok) {
      throw new Error("Failed to refresh messages: " + response.status);
    }
    updateKnownRevision(response);
    applyMessagesMarkup(await response.text());
    if (shouldStickAfterRefresh && typeof runtime.scheduleBottomStick === "function") {
      runtime.scheduleBottomStick();
      if (typeof runtime.bindPendingImages === "function") {
        runtime.bindPendingImages();
      }
    }
  } catch (error) {
    console.error(error);
  } finally {
    apricotRefreshInFlight = false;
    if (apricotRefreshQueued) {
      apricotRefreshQueued = false;
      void refreshMessages();
    }
  }
}

function handleUpdateMessage(event) {
  try {
    var payload = JSON.parse(event.data);
    var payloadChannel = typeof payload.channel === "string" ? payload.channel.toLowerCase() : "";
    if (payload.type !== "channel-updated" || payloadChannel !== apricotNormalizedUpdateChannel) {
      return;
    }
    var revision = Number(payload.revision || "0");
    if (Number.isFinite(revision) && revision > 0) {
      if (revision <= apricotLatestRevision) {
        return;
      }
      apricotLatestRevision = revision;
    }
    void refreshMessages();
  } catch (error) {
    console.error(error);
  }
}

function clearReconnectTimer() {
  if (apricotReconnectTimer) {
    window.clearTimeout(apricotReconnectTimer);
    apricotReconnectTimer = 0;
  }
}

function scheduleReconnect() {
  if (apricotReconnectTimer || apricotIsUnloading) {
    return;
  }
  apricotReconnectTimer = window.setTimeout(function () {
    apricotReconnectTimer = 0;
    connectUpdatesSocket();
  }, apricotReconnectDelayMs);
  apricotReconnectDelayMs = Math.min(apricotReconnectDelayMs * 2, apricotMaxReconnectDelayMs);
}

function connectUpdatesSocket() {
  if (apricotIsUnloading) {
    return;
  }
  if (apricotUpdateSocket && (
    apricotUpdateSocket.readyState === WebSocket.OPEN ||
    apricotUpdateSocket.readyState === WebSocket.CONNECTING
  )) {
    return;
  }

  try {
    apricotUpdateSocket = new WebSocket(getUpdatesUrl());
  } catch (error) {
    console.error(error);
    scheduleReconnect();
    return;
  }

  apricotUpdateSocket.addEventListener("open", function () {
    clearReconnectTimer();
    apricotReconnectDelayMs = 1000;
  });
  apricotUpdateSocket.addEventListener("message", handleUpdateMessage);
  apricotUpdateSocket.addEventListener("close", function () {
    apricotUpdateSocket = null;
    if (!apricotIsUnloading) {
      scheduleReconnect();
    }
  });
  apricotUpdateSocket.addEventListener("error", function () {
    if (apricotUpdateSocket && apricotUpdateSocket.readyState <= WebSocket.OPEN) {
      apricotUpdateSocket.close();
    }
  });
}

window.refreshMessages = refreshMessages;

window.addEventListener("beforeunload", function () {
  apricotIsUnloading = true;
  clearReconnectTimer();
  if (apricotUpdateSocket) {
    apricotUpdateSocket.close();
  }
});

window.setInterval(function () {
  if (!apricotUpdateSocket || apricotUpdateSocket.readyState !== WebSocket.OPEN) {
    void refreshMessages();
  }
}, apricotFallbackPollIntervalMs);

connectUpdatesSocket();`;
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

function buildNickChangeForm(nick: string, basePath: string): string {
  return `
<form action="${basePath}/nick" method="POST" class="admin-inline-form">
  <label class="admin-field">
    <span class="admin-field__label">現在のNICK</span>
    <input type="text" name="nick" value="${escapeHtml(nick)}" class="admin-input" autocomplete="nickname">
  </label>
  <button type="submit" class="admin-button admin-button--subtle">現在のNICKを変更</button>
</form>`;
}

function buildJoinForm(basePath: string): string {
  return `
<form action="${basePath}/join" method="POST" class="admin-inline-form">
  <input type="text" name="channel" placeholder="#channel" class="admin-input" autocomplete="off">
  <button type="submit" class="admin-button admin-button--primary">チャンネル参加</button>
</form>`;
}

function buildPersistedProxyConfigSection(
  basePath: string,
  configFormValues: { nick: string; autojoin: string },
): string {
  return `
  <section class="admin-panel">
    <div class="admin-panel__header">
      <div>
        <h2 class="admin-section-title">接続デフォルト設定</h2>
        <p class="admin-section-description">次回以降の接続時に使う nick と autojoin を保存します。</p>
      </div>
    </div>
    <div class="admin-message admin-message--info">
      <strong>保存だけを行い、現在の接続には即時反映しません。</strong>
      <span>空欄で保存すると、その項目の保存値をクリアして共有デフォルトへ戻します。</span>
    </div>
    <form action="${basePath}/config" method="POST" class="admin-form">
      <label class="admin-field">
        <span class="admin-field__label">保存用nick</span>
        <input type="text" name="nick" value="${escapeHtml(configFormValues.nick)}" class="admin-input" autocomplete="nickname">
      </label>
      <label class="admin-field">
        <span class="admin-field__label">autojoin (1行に1チャンネル)</span>
        <textarea name="autojoin" rows="4" class="admin-textarea" placeholder="#general&#10;#random">${escapeHtml(configFormValues.autojoin)}</textarea>
      </label>
      <div class="admin-form__actions">
        <button type="submit" class="admin-button admin-button--primary">接続デフォルト設定を保存</button>
      </div>
    </form>
  </section>`;
}

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
  configFormValues: { nick: string; autojoin: string } = { nick: "", autojoin: "" },
): string {
  const flashHtml = renderFlashMessage(flashMessage, flashTone);
  const adminBrandHtml = renderAdminBrand(`${basePath}/assets/apricot-logo.png`);
  const webAppHeadHtml = buildWebAppHead(basePath, "#f7f8f9");
  const nickForm = buildNickChangeForm(nick, basePath);
  const joinForm = buildJoinForm(basePath);
  const configPanelHtml = buildPersistedProxyConfigSection(basePath, configFormValues);
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
    <button type="submit" class="admin-button admin-button--danger">チャンネル離脱</button>
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
    .replace("{{WEB_APP_HEAD}}", webAppHeadHtml)
    .replace("{{ADMIN_BRAND}}", adminBrandHtml)
    .replace("{{STATUS_CLASS}}", statusClass)
    .replace("{{STATUS_TEXT}}", statusText)
    .replace("{{STATUS_ICON}}", connected ? "&#x1f7e2;" : "&#x1f534;")
    .split("{{NICK}}").join(escapeHtml(nick))
    .split("{{SERVER_NAME}}").join(escapeHtml(serverName))
    .replace("{{CHANNEL_COUNT}}", escapeHtml(channelCountText))
    .replace("{{TOP_ACTIONS}}", actionParts.join(""))
    .replace("{{FLASH_MESSAGE}}", flashHtml)
    .replace("{{NICK_FORM}}", nickForm)
    .replace("{{CHANNEL_LINKS}}", chLinks)
    .replace("{{CONFIG_PANEL}}", configPanelHtml);
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
  const adminBrandHtml = renderAdminBrand(`${basePath}/assets/apricot-logo.png`);
  const webAppHeadHtml = buildWebAppHead(basePath, "#f7f8f9");
  const topActionsHtml = `<a href="${basePath}/" class="admin-button admin-button--subtle">チャンネル一覧へ戻る</a>${renderAdminLogoutForm(basePath)}`;
  const colorPreviewHtml = buildSettingsPreviewHtml(webUiSettings);
  const errorHtml = renderSettingsError(errorMessage);
  const colorFieldsHtml = renderThemeColorFields(webUiSettings);
  const presetControlsHtml = renderThemePresetControls();
  const settingsScript = renderThemePresetScript();

  return SETTINGS_TEMPLATE
    .replace("{{CSS}}", buildAdminCss())
    .replace("{{WEB_APP_HEAD}}", webAppHeadHtml)
    .replace("{{ADMIN_BRAND}}", adminBrandHtml)
    .replace("{{NICK}}", escapeHtml(nick))
    .replace("{{SERVER_NAME}}", escapeHtml(serverName))
    .replace("{{TOP_ACTIONS}}", topActionsHtml)
    .replace("{{ERROR}}", errorHtml)
    .replace("{{ACTION_URL}}", `${basePath}/settings`)
    .replace("{{COLOR_PREVIEW}}", colorPreviewHtml)
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
  maxLines = DEFAULT_maxLines,
  onChannelLogsChanged?: ChannelLogsChangedCallback,
  enableRemoteUrlPreview = false,
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
    onChannelLogsChanged?.([channel]);
  }

  async function appendMessages(entries: Array<[string, StoredMessage]>): Promise<void> {
    if (entries.length === 0) return;
    for (const [channel, msg] of entries) {
      pushMessage(channel, msg);
    }
    await persistSnapshot();
    onChannelLogsChanged?.(Array.from(new Set(entries.map(([channel]) => channel))));
  }

  async function buildTextMessage(
    type: "privmsg" | "notice" | "self",
    nick: string,
    text: string,
    embed?: ResolvedUrlEmbed,
    shouldResolveEmbed = false,
  ): Promise<StoredMessage> {
    return {
      time: Date.now(),
      type,
      nick,
      text,
      embed: embed ?? (shouldResolveEmbed ? await resolveMessageEmbed(text) : undefined),
    };
  }

  const module = defineModule("web", (m) => {
    m.on("ss_privmsg", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      const text = msg.params[1] || "";
      const channel = isChannel(target) ? target : nick; // DM keyed by sender nick
      await appendMessage(channel, await buildTextMessage("privmsg", nick, text, undefined, enableRemoteUrlPreview));
      return msg;
    });

    m.on("ss_notice", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      const text = msg.params[1] || "";
      const channel = isChannel(target) ? target : nick;
      await appendMessage(channel, await buildTextMessage("notice", nick, text, undefined, enableRemoteUrlPreview));
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
    webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
    themeCssHref = ""
  ): string {
    const channelBasePath = `${basePath}/${encodeURIComponent(channel)}`;
    const messagesUrl = `${channelBasePath}/messages`;
    const composerUrl = `${channelBasePath}/composer`;
    const messagesFrameHtml = `<iframe id="channel-messages-frame" class="channel-frame channel-frame--messages" src="${messagesUrl}" title="${escapeHtml(channel)} messages"></iframe>`;
    const composerFrameHtml = `<iframe id="channel-composer-frame" class="channel-frame channel-frame--composer" src="${composerUrl}" title="${escapeHtml(channel)} composer"></iframe>`;
    const frameBodyHtml = webUiSettings.displayOrder === "asc"
      ? `${messagesFrameHtml}\n${composerFrameHtml}`
      : `${composerFrameHtml}\n${messagesFrameHtml}`;
    const frameContent = webUiSettings.displayOrder === "asc"
      ? `${frameBodyHtml}\n${buildChannelShellInitialStickScript()}`
      : frameBodyHtml;
    const webAppHeadHtml = buildWebAppHead(basePath, webUiSettings.surfaceColor);

    return CHANNEL_SHELL_TEMPLATE
      .replace("{{WEB_APP_HEAD}}", webAppHeadHtml)
      .replace("{{CSS}}", buildChannelCss(webUiSettings))
      .replace("{{THEME_CSS_LINK}}", themeCssHref ? `<link rel="stylesheet" href="${themeCssHref}">` : "")
      .replace("{{CHANNEL}}", escapeHtml(channel))
      .replace("{{TOPIC}}", escapeHtml(topic))
      .replace("{{FRAME_CONTENT}}", frameContent);
  }

  function buildChannelMessagesPage(
    channel: string,
    topic: string,
    selfNick: string,
    webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
    channelRevision = 0,
    themeCssHref = ""
  ): string {
    const messagesHtml = buildChannelMessagesFragment(channel, selfNick, webUiSettings);
    const reloadButton = webUiSettings.displayOrder === "desc"
      ? '<button type="button" class="floating" onclick="void refreshMessages();">再読込</button>'
      : "";
    const scriptParts: string[] = [
      buildMessagesPageScript(channel, webUiSettings, channelRevision),
    ];
    if (webUiSettings.displayOrder === "asc") {
      scriptParts.push(buildConditionalAutoScrollScript(channel));
    }
    if (!webUiSettings.enableInlineUrlPreview) {
      scriptParts.push(buildPreviewScript());
    }

    return CHANNEL_MESSAGES_TEMPLATE
      .replace("{{CSS}}", buildChannelCss(webUiSettings))
      .replace("{{THEME_CSS_LINK}}", themeCssHref ? `<link rel="stylesheet" href="${themeCssHref}">` : "")
      .replace("{{CHANNEL}}", escapeHtml(channel))
      .replace("{{TOPIC}}", escapeHtml(topic))
      .replace("{{RELOAD_BUTTON}}", reloadButton)
      .replace("{{AUTO_SCROLL_SCRIPT}}", scriptParts.join("\n"))
      .replace("{{MESSAGES}}", messagesHtml);
  }

  /**
   * Builds only the channel message list markup so Fetch refreshes can reuse
   * the same server-side rendering as the initial page.
   */
  function buildChannelMessagesFragment(
    channel: string,
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
    return lines + popupHtml;
  }

  function buildChannelComposerPage(
    channel: string,
    basePath: string,
    messageValue = "",
    flashMessage = "",
    flashTone: "info" | "danger" = "info",
    webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
    shouldReloadMessages = false,
    themeCssHref = ""
  ): string {
    const actionUrl = `${basePath}/${encodeURIComponent(channel)}/composer`;
    const channelListLink = `<a href="${basePath}/" target="_top" class="channel-list-link" aria-label="チャンネル一覧へ戻る" title="チャンネル一覧へ戻る">☰</a>`;
    const flashHtml = renderFlashMessage(flashMessage, flashTone);
    const onLoadScript = buildComposerOnLoadScript(shouldReloadMessages);

    return CHANNEL_COMPOSER_TEMPLATE
      .replace("{{CSS}}", buildChannelCss(webUiSettings))
      .replace("{{THEME_CSS_LINK}}", themeCssHref ? `<link rel="stylesheet" href="${themeCssHref}">` : "")
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
    buildChannelMessagesFragment,
    buildChannelComposerPage,
    recordSelfMessage,
    getChannelTopic,
    snapshotLogs,
    hydrateLogs,
    getChannelLogs,
  };
}
