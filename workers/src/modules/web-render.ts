/**
 * Web UI の HTML 描画とページ組み立てを扱う。
 */

import CHANNEL_SHELL_TEMPLATE from "../templates/channel.html";
import CHANNEL_MESSAGES_TEMPLATE from "../templates/channel-messages.html";
import CHANNEL_COMPOSER_TEMPLATE from "../templates/channel-composer.html";
import CHANNEL_LIST_TEMPLATE from "../templates/channel-list.html";
import SETTINGS_TEMPLATE from "../templates/settings.html";
import type { ResolvedUrlEmbed } from "./url-metadata";
import {
  buildAdminCss,
  buildChannelCss,
  buildWebAppHead,
  DARK_WEB_UI_COLOR_PRESET,
  DEFAULT_WEB_UI_SETTINGS,
  LIGHT_WEB_UI_COLOR_PRESET,
  WEB_UI_COLOR_FIELDS,
} from "./web-theme";
import type {
  FlashTone,
  RenderedChannelMessagesFragment,
  StoredMessage,
  WebUiSettings,
} from "./web-types";

const SETTINGS_PREVIEW_CHANNEL_NAME = "#preview";
const SETTINGS_PREVIEW_TOPIC = "配色プレビュー";
const SETTINGS_PREVIEW_MESSAGE_VALUE = "送信テキストの見本";
const SETTINGS_PREVIEW_SELF_NICK = "apricot";
const SETTINGS_PREVIEW_HIGHLIGHT_KEYWORDS = ["重要ワード"];
const SETTINGS_PREVIEW_DIM_KEYWORDS = ["log noise"];
const SETTINGS_PREVIEW_MESSAGES: ReadonlyArray<StoredMessage> = [
  { sequence: 1, time: (9 * 60 + 41) * 60_000, type: "self", nick: SETTINGS_PREVIEW_SELF_NICK, text: "プレビュー表示を確認します" },
  { sequence: 2, time: (9 * 60 + 42) * 60_000, type: "privmsg", nick: "alice", text: "資料は https://example.com/docs にあります" },
  { sequence: 3, time: (9 * 60 + 43) * 60_000, type: "privmsg", nick: "bob", text: "重要ワード を含むメッセージです" },
  { sequence: 4, time: (9 * 60 + 44) * 60_000, type: "notice", nick: "server", text: "log noise: バックグラウンド通知" },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderColorValue(color: string): string {
  return color.toUpperCase();
}

function renderSettingsError(errorMessage: string): string {
  return errorMessage
    ? `<div class="admin-message admin-message--danger" role="alert"><strong>設定を保存できませんでした。</strong><span>${escapeHtml(errorMessage)}</span></div>`
    : "";
}

function renderFlashMessage(message: string, tone: FlashTone): string {
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

function escapeIframeSrcdoc(documentHtml: string): string {
  return escapeHtml(documentHtml);
}

function parseKeywords(raw: string): string[] {
  return raw.split(/[\n,]/).map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0);
}

function renderEmbedDataAttributes(embed: ResolvedUrlEmbed, previewTemplateId?: string): string {
  const attrs = [
    `data-preview-kind="${escapeHtml(embed.kind)}"`,
    `data-preview-source-url="${escapeHtml(embed.sourceUrl)}"`,
  ];
  if (previewTemplateId) {
    attrs.push(`data-preview-template-id="${escapeHtml(previewTemplateId)}"`);
  }
  if (embed.kind === "rich") {
    return attrs.join(" ");
  }
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

function renderRichEmbedMarkup(
  embed: ResolvedUrlEmbed,
  variant: "inline" | "popup",
): string {
  const baseClass = variant === "inline" ? "url-embed url-embed--inline" : "url-embed url-embed--popup";
  return `<div class="${baseClass} url-embed--rich">
    <div class="url-embed__rich-content" data-apricot-rich-embed>
      ${embed.html ?? ""}
    </div>
  </div>`;
}

function renderRichEmbedTemplate(embed: ResolvedUrlEmbed, templateId: string): string {
  return `<template id="${escapeHtml(templateId)}">${renderRichEmbedMarkup(embed, "popup")}</template>`;
}

function renderUrlEmbed(embed: ResolvedUrlEmbed, variant: "inline" | "popup"): string {
  if (embed.kind === "rich" && embed.html) {
    return renderRichEmbedMarkup(embed, variant);
  }

  const baseClass = variant === "inline" ? "url-embed url-embed--inline" : "url-embed url-embed--popup";
  const embedClass = embed.imageUrl ? baseClass : `${baseClass} url-embed--text-only`;
  const imageClass = embed.kind === "image" ? "url-embed__image url-embed__image--full" : "url-embed__image";
  const siteNameHtml = embed.siteName ? `<span class="url-embed__site">${escapeHtml(embed.siteName)}</span>` : "";
  const titleHtml = embed.title ? `<span class="url-embed__title">${escapeHtml(embed.title)}</span>` : "";
  const descriptionHtml = embed.description ? `<span class="url-embed__description">${escapeHtml(embed.description)}</span>` : "";
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

function buildRichEmbedScript(): string {
  return `window.__apricotRichEmbedState = window.__apricotRichEmbedState || {
  initialized: false,
  loaderRequested: false,
  pendingRoots: [],
  renderedHandlerBound: false,
  loadedHandlerBound: false
};

window.initializeApricotRichEmbeds = window.initializeApricotRichEmbeds || function initializeApricotRichEmbeds() {
  var state = window.__apricotRichEmbedState;
  if (state.initialized) {
    return;
  }
  state.initialized = true;

  function flushPendingRoots() {
    if (!window.twttr || !window.twttr.widgets || typeof window.twttr.widgets.load !== "function") {
      return;
    }
    while (state.pendingRoots.length > 0) {
      var root = state.pendingRoots.shift();
      if (root instanceof Element || root instanceof Document || root === document.body) {
        window.twttr.widgets.load(root);
      }
    }
  }

  function requestLoader() {
    if (state.loaderRequested) {
      return;
    }
    state.loaderRequested = true;
    window.twttr = (function (d, s, id) {
      var js;
      var firstScript = d.getElementsByTagName(s)[0];
      var twttr = window.twttr || {};
      if (d.getElementById(id)) {
        return twttr;
      }
      js = d.createElement(s);
      js.id = id;
      js.src = "https://platform.twitter.com/widgets.js";
      js.async = true;
      if (firstScript && firstScript.parentNode) {
        firstScript.parentNode.insertBefore(js, firstScript);
      } else {
        d.head.appendChild(js);
      }
      twttr._e = twttr._e || [];
      twttr.ready = function (callback) {
        twttr._e.push(callback);
      };
      return twttr;
    }(document, "script", "twitter-wjs"));

    window.twttr.ready(function (twttr) {
      if (twttr.events && typeof twttr.events.bind === "function" && !state.loadedHandlerBound) {
        state.loadedHandlerBound = true;
        twttr.events.bind("loaded", function () {
          window.dispatchEvent(new CustomEvent("apricot-rich-embed-loaded"));
        });
      }
      if (twttr.events && typeof twttr.events.bind === "function" && !state.renderedHandlerBound) {
        state.renderedHandlerBound = true;
        twttr.events.bind("rendered", function (event) {
          window.dispatchEvent(new CustomEvent("apricot-rich-embed-loaded", {
            detail: {
              target: event && event.target ? event.target : null
            }
          }));
        });
      }
      flushPendingRoots();
    });
  }

  window.apricotRefreshRichEmbeds = function apricotRefreshRichEmbeds(root) {
    var targetRoot = root || document.body;
    if (!targetRoot || !(targetRoot instanceof Element || targetRoot instanceof Document || targetRoot === document.body)) {
      return;
    }
    if (!targetRoot.querySelector || !targetRoot.querySelector("[data-apricot-rich-embed]")) {
      return;
    }
    state.pendingRoots.push(targetRoot);
    requestLoader();
    flushPendingRoots();
  };
};

window.initializeApricotRichEmbeds();
window.apricotRefreshRichEmbeds(document.body);`;
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
    var popupRich = popup.querySelector("[data-preview-popup-rich]");
    if (!popupEmbed || !popupImage || !popupSite || !popupTitle || !popupDescription || !popupRich) {
      return null;
    }
    return {
      popup: popup,
      popupEmbed: popupEmbed,
      popupImage: popupImage,
      popupSite: popupSite,
      popupTitle: popupTitle,
      popupDescription: popupDescription,
      popupRich: popupRich
    };
  }

  function findPreviewLink(target) {
    return target instanceof Element ? target.closest("a[data-preview-kind]") : null;
  }

  function clearPopupRich(popupParts) {
    popupParts.popupRich.replaceChildren();
    popupParts.popupRich.hidden = true;
  }

  function resetPopupEmbed(popupParts) {
    popupParts.popupEmbed.hidden = true;
    popupParts.popupEmbed.classList.remove("url-embed--text-only");
    popupParts.popupImage.hidden = true;
    popupParts.popupImage.removeAttribute("src");
    popupParts.popupImage.setAttribute("alt", "URL preview");
    popupParts.popupImage.className = "url-embed__image";
    popupParts.popupSite.textContent = "";
    popupParts.popupTitle.textContent = "";
    popupParts.popupDescription.textContent = "";
    popupParts.popupDescription.hidden = true;
  }

  function fillPopup(link) {
    var popupParts = getPopupParts(getPopup());
    if (!popupParts) {
      return false;
    }
    resetPopupEmbed(popupParts);
    clearPopupRich(popupParts);
    if (link.dataset.previewKind === "rich") {
      var templateId = link.dataset.previewTemplateId;
      var template = templateId ? document.getElementById(templateId) : null;
      if (!(template instanceof HTMLTemplateElement)) {
        return false;
      }
      popupParts.popupRich.appendChild(template.content.cloneNode(true));
      popupParts.popupRich.hidden = false;
      popupParts.popup.classList.remove("url-preview-popup--card");
      if (typeof window.apricotRefreshRichEmbeds === "function") {
        window.apricotRefreshRichEmbeds(popupParts.popupRich);
      }
      return true;
    }
    popupParts.popupEmbed.hidden = false;
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
    var popupParts = getPopupParts(getPopup());
    if (popupParts) {
      resetPopupEmbed(popupParts);
      clearPopupRich(popupParts);
    }
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
  window.addEventListener("apricot-rich-embed-loaded", function () {
    if (state.activeLink) {
      positionPopup(state.activeLink);
    }
  });
};

window.initializeApricotPreview();`;
}

function buildConditionalAutoScrollScript(channel: string): string {
  const storageKey = JSON.stringify(`apricot:scroll-stick:${channel.toLowerCase()}`);
  return `window.apricotMessagesRuntime = window.apricotMessagesRuntime || {};
var nearBottomThreshold = 48;
var scrollStateStorageKey = ${storageKey};
var shouldStickToBottom = readShouldStickToBottom();
var messagesShellResizeObserver = null;

function getScrollRoot() {
  return document.scrollingElement || document.documentElement;
}

function getMessagesShell() {
  return document.getElementById("channel-messages-shell");
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

function handleMessagesShellResize() {
  if (!shouldStickToBottom) {
    return;
  }
  window.requestAnimationFrame(stickToBottomIfNeeded);
}

function bindMessagesShellResize() {
  if (messagesShellResizeObserver || typeof ResizeObserver !== "function") {
    return;
  }
  var shell = getMessagesShell();
  if (!shell) {
    return;
  }
  messagesShellResizeObserver = new ResizeObserver(function () {
    handleMessagesShellResize();
  });
  messagesShellResizeObserver.observe(shell);
}

if (shouldStickToBottom) {
  scheduleBottomStick();
  bindPendingImages();
  bindMessagesShellResize();
}

window.addEventListener("scroll", updateShouldStickToBottom, { passive: true });
window.addEventListener("apricot-rich-embed-loaded", function (event) {
  var detail = event && event.detail;
  var target = detail && detail.target;
  var shell = getMessagesShell();
  if (shell && target instanceof Element && !shell.contains(target)) {
    return;
  }
  bindMessagesShellResize();
  handleMessagesShellResize();
});

window.addEventListener("beforeunload", function () {
  updateShouldStickToBottom();
  if (messagesShellResizeObserver && typeof messagesShellResizeObserver.disconnect === "function") {
    messagesShellResizeObserver.disconnect();
  }
});

window.apricotMessagesRuntime.getScrollRoot = getScrollRoot;
window.apricotMessagesRuntime.getMessagesShell = getMessagesShell;
window.apricotMessagesRuntime.scrollToBottom = scrollToBottom;
window.apricotMessagesRuntime.isNearBottom = isNearBottom;
window.apricotMessagesRuntime.setShouldStickToBottom = setShouldStickToBottom;
window.apricotMessagesRuntime.updateShouldStickToBottom = updateShouldStickToBottom;
window.apricotMessagesRuntime.stickToBottomIfNeeded = stickToBottomIfNeeded;
window.apricotMessagesRuntime.scheduleBottomStick = scheduleBottomStick;
window.apricotMessagesRuntime.bindPendingImages = bindPendingImages;
window.apricotMessagesRuntime.bindMessagesShellResize = bindMessagesShellResize;
window.apricotMessagesRuntime.handleMessagesShellResize = handleMessagesShellResize;
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
      "}",
    );
  }

  return scriptLines.join("\n");
}

function buildMessagesPageScript(channel: string, webUiSettings: WebUiSettings, initialSequence = 0): string {
  const serializedChannel = JSON.stringify(channel);
  const shouldAutoStick = webUiSettings.displayOrder === "asc";
  return `window.apricotMessagesRuntime = window.apricotMessagesRuntime || {};
var apricotUpdateChannel = ${serializedChannel};
var apricotNormalizedUpdateChannel = apricotUpdateChannel.toLowerCase();
var apricotShouldAutoStick = ${shouldAutoStick ? "true" : "false"};
var apricotRefreshInFlight = false;
var apricotRefreshQueued = false;
var apricotLatestSequence = ${initialSequence};
var apricotUpdateSocket = null;
var apricotUpdateSocketGeneration = 0;
var apricotReconnectDelayMs = 1000;
var apricotReconnectTimer = 0;
var apricotHeartbeatTimer = 0;
var apricotMaxReconnectDelayMs = 30000;
var apricotFallbackPollIntervalMs = 30000;
var apricotHeartbeatIntervalMs = 30000;
var apricotMissedHeartbeatLimit = 2;
var apricotMissedHeartbeatCount = 0;
var apricotHasIssuedDegradedRefresh = false;
var apricotLastSocketActivityAt = 0;
var apricotLastHeartbeatSentAt = 0;
var apricotIsUnloading = false;

function getMessagesShell() {
  return document.getElementById("channel-messages-shell");
}

function getFragmentUrl() {
  return window.location.pathname.replace(/\\/messages\\/?$/, "/messages/fragment");
}

function getFragmentRequestUrl() {
  return getFragmentUrl() + "?since=" + encodeURIComponent(String(apricotLatestSequence));
}

function getUpdatesUrl() {
  var path = window.location.pathname.replace(/\\/messages\\/?$/, "/updates");
  var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return protocol + "//" + window.location.host + path;
}

function isValidSequence(sequence) {
  return Number.isFinite(sequence) && sequence >= 0;
}

function readFragmentMetadata(response) {
  var latestSequence = Number(response.headers.get("X-Apricot-Channel-Sequence") || "0");
  var startSequence = Number(response.headers.get("X-Apricot-Fragment-Start-Sequence") || "0");
  var mode = response.headers.get("X-Apricot-Fragment-Mode") || "full";
  return {
    latestSequence: isValidSequence(latestSequence) ? latestSequence : apricotLatestSequence,
    startSequence: isValidSequence(startSequence) ? startSequence : 0,
    mode: mode === "delta" ? "delta" : "full"
  };
}

function debugUpdateSocket(message, socketGeneration) {
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug("[apricot-updates]", apricotNormalizedUpdateChannel, "gen=" + String(socketGeneration), message);
  }
}

function applyMessagesMarkup(html) {
  var shell = getMessagesShell();
  if (!shell) {
    return;
  }
  shell.innerHTML = html;
  if (typeof window.apricotRefreshRichEmbeds === "function") {
    window.apricotRefreshRichEmbeds(shell);
  }
  if (typeof window.initializeApricotPreview === "function") {
    window.initializeApricotPreview();
  }
}

function applyMessagesDelta(html) {
  var shell = getMessagesShell();
  if (!shell || !html) {
    return;
  }
  var template = document.createElement("template");
  template.innerHTML = html;
  var addedNodes = Array.prototype.slice.call(template.content.childNodes);
  if (apricotShouldAutoStick) {
    shell.appendChild(template.content);
  } else {
    shell.prepend(template.content);
  }
  if (typeof window.apricotRefreshRichEmbeds === "function") {
    addedNodes.forEach(function (node) {
      if (!(node instanceof Element)) {
        return;
      }
      if (!node.querySelector("[data-apricot-rich-embed]")) {
        return;
      }
      window.apricotRefreshRichEmbeds(node);
    });
  }
}

function resetHeartbeatState() {
  apricotMissedHeartbeatCount = 0;
  apricotHasIssuedDegradedRefresh = false;
  apricotLastSocketActivityAt = 0;
  apricotLastHeartbeatSentAt = 0;
}

function markSocketHealthy() {
  apricotMissedHeartbeatCount = 0;
  apricotHasIssuedDegradedRefresh = false;
  apricotLastSocketActivityAt = Date.now();
}

function isCurrentSocketGeneration(socketGeneration) {
  return socketGeneration === apricotUpdateSocketGeneration;
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
    var response = await fetch(getFragmentRequestUrl(), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Requested-With": "apricot-fetch" }
    });
    if (!response.ok) {
      throw new Error("Failed to refresh messages: " + response.status);
    }
    var fragmentMetadata = readFragmentMetadata(response);
    var responseText = await response.text();
    var shouldApplyDelta = fragmentMetadata.mode === "delta" && fragmentMetadata.startSequence === apricotLatestSequence;
    if (shouldApplyDelta) {
      applyMessagesDelta(responseText);
    } else {
      applyMessagesMarkup(responseText);
    }
    apricotLatestSequence = fragmentMetadata.latestSequence;
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

function handleUpdateMessage(event, socketGeneration) {
  if (!isCurrentSocketGeneration(socketGeneration)) {
    return;
  }
  try {
    var payload = JSON.parse(event.data);
    var payloadType = typeof payload.type === "string" ? payload.type : "";
    if (payloadType === "pong") {
      markSocketHealthy();
      return;
    }
    var payloadChannel = typeof payload.channel === "string" ? payload.channel.toLowerCase() : "";
    if (payloadType !== "channel-updated" || payloadChannel !== apricotNormalizedUpdateChannel) {
      return;
    }
    markSocketHealthy();
    var nextSequence = Number(payload.sequence || "0");
    if (!isValidSequence(nextSequence) || nextSequence <= apricotLatestSequence) {
      return;
    }
    debugUpdateSocket("channel update sequence=" + String(nextSequence), socketGeneration);
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

function clearHeartbeatTimer() {
  if (apricotHeartbeatTimer) {
    window.clearInterval(apricotHeartbeatTimer);
    apricotHeartbeatTimer = 0;
  }
}

function closeTrackedUpdateSocket(socket, socketGeneration, reason) {
  if (!socket || socket.readyState > WebSocket.OPEN) {
    return;
  }
  debugUpdateSocket("close requested: " + reason, socketGeneration);
  socket.close();
}

function forceReconnectUpdatesSocket(reason) {
  if (apricotIsUnloading) {
    return;
  }
  var previousSocket = apricotUpdateSocket;
  var previousGeneration = apricotUpdateSocketGeneration;
  clearHeartbeatTimer();
  resetHeartbeatState();
  apricotUpdateSocket = null;
  debugUpdateSocket("force reconnect: " + reason, previousGeneration);
  connectUpdatesSocket();
  closeTrackedUpdateSocket(previousSocket, previousGeneration, reason);
}

function handleHeartbeatFailure() {
  apricotMissedHeartbeatCount += 1;
  debugUpdateSocket("heartbeat miss count=" + String(apricotMissedHeartbeatCount), apricotUpdateSocketGeneration);
  if (apricotMissedHeartbeatCount < apricotMissedHeartbeatLimit || apricotHasIssuedDegradedRefresh) {
    return;
  }
  apricotHasIssuedDegradedRefresh = true;
  var staleSocketGeneration = apricotUpdateSocketGeneration;
  debugUpdateSocket("degraded refresh started", staleSocketGeneration);
  void refreshMessages().finally(function () {
    if (!isCurrentSocketGeneration(staleSocketGeneration)) {
      return;
    }
    debugUpdateSocket("degraded refresh completed", staleSocketGeneration);
    forceReconnectUpdatesSocket("heartbeat-stale");
  });
}

function sendHeartbeat() {
  if (!apricotUpdateSocket || apricotUpdateSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (apricotLastHeartbeatSentAt > 0 && apricotLastSocketActivityAt < apricotLastHeartbeatSentAt) {
    handleHeartbeatFailure();
    if (!apricotUpdateSocket || apricotUpdateSocket.readyState !== WebSocket.OPEN) {
      return;
    }
  }

  apricotLastHeartbeatSentAt = Date.now();
  try {
    apricotUpdateSocket.send(JSON.stringify({ type: "ping" }));
    debugUpdateSocket("heartbeat ping sent", apricotUpdateSocketGeneration);
  } catch (error) {
    console.error(error);
    forceReconnectUpdatesSocket("heartbeat-send-failed");
  }
}

function startHeartbeatTimer() {
  clearHeartbeatTimer();
  apricotHeartbeatTimer = window.setInterval(function () {
    sendHeartbeat();
  }, apricotHeartbeatIntervalMs);
}

function startFallbackRefreshPoll() {
  // Heartbeat 導入により現状は未使用。将来の運用切替用に保持している。
  return window.setInterval(function () {
    if (!apricotUpdateSocket || apricotUpdateSocket.readyState !== WebSocket.OPEN) {
      void refreshMessages();
    }
  }, apricotFallbackPollIntervalMs);
}

function scheduleReconnect() {
  if (apricotReconnectTimer || apricotIsUnloading || apricotUpdateSocket) {
    return;
  }
  debugUpdateSocket("schedule reconnect", apricotUpdateSocketGeneration);
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
  if (apricotUpdateSocket && (apricotUpdateSocket.readyState === WebSocket.OPEN || apricotUpdateSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  apricotUpdateSocketGeneration += 1;
  var socketGeneration = apricotUpdateSocketGeneration;
  clearHeartbeatTimer();
  resetHeartbeatState();
  debugUpdateSocket("connect attempt", socketGeneration);
  try {
    apricotUpdateSocket = new WebSocket(getUpdatesUrl());
  } catch (error) {
    console.error(error);
    scheduleReconnect();
    return;
  }

  apricotUpdateSocket.addEventListener("open", function () {
    if (!isCurrentSocketGeneration(socketGeneration)) {
      return;
    }
    debugUpdateSocket("socket open", socketGeneration);
    clearReconnectTimer();
    apricotReconnectDelayMs = 1000;
    resetHeartbeatState();
    markSocketHealthy();
    startHeartbeatTimer();
  });
  apricotUpdateSocket.addEventListener("message", function (event) {
    handleUpdateMessage(event, socketGeneration);
  });
  apricotUpdateSocket.addEventListener("close", function () {
    debugUpdateSocket("socket close", socketGeneration);
    if (!isCurrentSocketGeneration(socketGeneration)) {
      return;
    }
    clearHeartbeatTimer();
    resetHeartbeatState();
    apricotUpdateSocket = null;
    if (!apricotIsUnloading) {
      scheduleReconnect();
    }
  });
  apricotUpdateSocket.addEventListener("error", function () {
    debugUpdateSocket("socket error", socketGeneration);
    if (!isCurrentSocketGeneration(socketGeneration)) {
      return;
    }
    closeTrackedUpdateSocket(apricotUpdateSocket, socketGeneration, "socket-error");
  });
}

window.refreshMessages = refreshMessages;

window.addEventListener("beforeunload", function () {
  apricotIsUnloading = true;
  clearReconnectTimer();
  clearHeartbeatTimer();
  closeTrackedUpdateSocket(apricotUpdateSocket, apricotUpdateSocketGeneration, "beforeunload");
});

connectUpdatesSocket();`;
}

function renderText(
  raw: string,
  highlightKeywords: string[] = [],
  embed?: ResolvedUrlEmbed,
  enablePopupPreview = false,
  previewTemplateId?: string,
): string {
  const urlRe = /(https?:\/\/[^\s<>"]+)/g;
  let result = "";
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRe.exec(raw)) !== null) {
    result += escapeHtml(raw.slice(last, match.index));
    const url = match[1];
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = url;
    }
    const previewAttrs = enablePopupPreview && embed?.sourceUrl === url
      ? ` class="url-link url-link--preview" ${renderEmbedDataAttributes(embed, previewTemplateId)}`
      : ' class="url-link"';
    result += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"${previewAttrs}>${escapeHtml(hostname)}</a>`;
    last = match.index + url.length;
  }
  result += escapeHtml(raw.slice(last));

  if (highlightKeywords.length === 0) {
    return result;
  }

  const escapedKeywords = highlightKeywords.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const keywordRe = new RegExp(`(${escapedKeywords.join("|")})`, "gi");
  return result.replace(/(<a [^>]*>.*?<\/a>)|([^<]+)/g, (_, anchor, text) => {
    if (anchor) {
      return anchor;
    }
    return text.replace(keywordRe, '<span class="keyword-hl">$1</span>');
  });
}

function formatTime(ms: number, offsetHours: number): string {
  const date = new Date(ms + offsetHours * 3_600_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

type EventRenderer = (message: StoredMessage, timestampHtml: string) => string;

const EVENT_MESSAGE_RENDERERS: Record<Exclude<StoredMessage["type"], "privmsg" | "notice" | "self">, EventRenderer> = {
  join: (message, timestampHtml) => `${timestampHtml} <span class="timestamp">*** ${escapeHtml(message.nick)} has joined ${escapeHtml(message.text)}</span>`,
  part: (message, timestampHtml) => `${timestampHtml} <span class="timestamp">*** ${escapeHtml(message.nick)} has left ${escapeHtml(message.text)}</span>`,
  quit: (message, timestampHtml) => `${timestampHtml} <span class="timestamp">*** ${escapeHtml(message.nick)} has quit (${escapeHtml(message.text)})</span>`,
  kick: (message, timestampHtml) => `${timestampHtml} <span class="timestamp">*** ${escapeHtml(message.text)}</span>`,
  nick: (message, timestampHtml) => `${timestampHtml} <span class="timestamp">*** ${escapeHtml(message.nick)} is now known as ${escapeHtml(message.text)}</span>`,
  topic: (message, timestampHtml) => `${timestampHtml} <span class="timestamp">*** ${escapeHtml(message.nick)} changed topic to: ${escapeHtml(message.text)}</span>`,
  mode: (message, timestampHtml) => `${timestampHtml} <span class="timestamp">*** ${escapeHtml(message.nick)} sets mode ${escapeHtml(message.text)}</span>`,
};

function renderMessage(
  message: StoredMessage,
  selfNick: string,
  offsetHours: number,
  highlightKeywords: string[],
  webUiSettings: WebUiSettings,
  renderKey: string,
): string {
  const timestampHtml = `<span class="timestamp">${formatTime(message.time, offsetHours)}</span>`;
  const isSelf = message.nick.toLowerCase() === selfNick.toLowerCase();
  const nickClass = isSelf ? "username-self" : "username-other";
  const canUsePopupPreview = !webUiSettings.enableInlineUrlPreview && Boolean(message.embed);
  const popupTemplateId = canUsePopupPreview && message.embed?.kind === "rich"
    ? `url-preview-template-${renderKey}`
    : undefined;
  const inlineEmbedHtml = webUiSettings.enableInlineUrlPreview && message.embed
    ? `<div class="url-embed-container">${renderUrlEmbed(message.embed, "inline")}</div>`
    : "";
  const popupTemplateHtml = popupTemplateId && message.embed?.kind === "rich" && message.embed.html
    ? renderRichEmbedTemplate(message.embed, popupTemplateId)
    : "";

  let messageHtml: string;
  if (message.type === "privmsg") {
    messageHtml = `${timestampHtml} <span class="${nickClass}">${escapeHtml(message.nick)}&gt;</span> ${renderText(message.text, highlightKeywords, message.embed, canUsePopupPreview, popupTemplateId)}${inlineEmbedHtml}`;
  } else if (message.type === "notice") {
    messageHtml = `${timestampHtml} <span class="${nickClass}">(${escapeHtml(message.nick)})</span> ${renderText(message.text, highlightKeywords, message.embed, canUsePopupPreview, popupTemplateId)}${inlineEmbedHtml}`;
  } else if (message.type === "self") {
    messageHtml = `${timestampHtml} <span class="username-self">${escapeHtml(message.nick)}&gt;</span> ${renderText(message.text, highlightKeywords, message.embed, canUsePopupPreview, popupTemplateId)}${inlineEmbedHtml}`;
  } else {
    messageHtml = EVENT_MESSAGE_RENDERERS[message.type](message, timestampHtml);
  }

  return `${messageHtml}${popupTemplateHtml}`;
}

function buildSettingsPreviewMessageEntries(webUiSettings: WebUiSettings): Array<{ html: string; isDimmed: boolean }> {
  return SETTINGS_PREVIEW_MESSAGES.map((message) => ({
    html: renderMessage(
      message,
      SETTINGS_PREVIEW_SELF_NICK,
      0,
      SETTINGS_PREVIEW_HIGHLIGHT_KEYWORDS,
      webUiSettings,
      `preview-${message.sequence}`,
    ),
    isDimmed: SETTINGS_PREVIEW_DIM_KEYWORDS.some((keyword) => message.text.toLowerCase().includes(keyword.toLowerCase())),
  }));
}

function buildSettingsPreviewMessagesMarkup(webUiSettings: WebUiSettings): string {
  const lineEntries = buildSettingsPreviewMessageEntries(webUiSettings);
  const orderedEntries = webUiSettings.displayOrder === "asc" ? lineEntries : [...lineEntries].reverse();
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

function buildSettingsPreviewFrameHtml(kind: "messages" | "composer", title: string, documentHtml: string): string {
  return `<iframe class="channel-frame channel-frame--${kind}" title="${escapeHtml(title)}" sandbox srcdoc="${escapeIframeSrcdoc(documentHtml)}"></iframe>`;
}

function buildSettingsPreviewShellDocument(webUiSettings: WebUiSettings): string {
  const messagesFrameHtml = buildSettingsPreviewFrameHtml("messages", "チャンネル表示プレビュー", buildSettingsPreviewMessagesDocument(webUiSettings));
  const composerFrameHtml = buildSettingsPreviewFrameHtml("composer", "送信フォームプレビュー", buildSettingsPreviewComposerDocument(webUiSettings));
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

function buildSettingsPreviewHtml(webUiSettings: WebUiSettings): string {
  return `<section class="theme-preview" data-theme-preview-root>
  <div class="theme-preview__header">
    <h3 class="theme-preview__title">表示プレビュー</h3>
    <p class="theme-preview__description">フォント、配色、表示順の変更結果を保存前に確認できます。</p>
  </div>
  <iframe class="theme-preview__frame" data-theme-preview-frame title="チャンネルシェルプレビュー" sandbox srcdoc="${escapeIframeSrcdoc(buildSettingsPreviewShellDocument(webUiSettings))}"></iframe>
</section>`;
}

function renderThemePresetScript(): string {
  const lightPreset = JSON.stringify(LIGHT_WEB_UI_COLOR_PRESET);
  const darkPreset = JSON.stringify(DARK_WEB_UI_COLOR_PRESET);
  const colorFieldNames = JSON.stringify(WEB_UI_COLOR_FIELDS.map(({ name }) => name));
  const channelShellTemplate = JSON.stringify(CHANNEL_SHELL_TEMPLATE);
  const previewMessageEntries = JSON.stringify(buildSettingsPreviewMessageEntries(DEFAULT_WEB_UI_SETTINGS));
  const defaultPreviewSettings = JSON.stringify(DEFAULT_WEB_UI_SETTINGS);
  const previewChannelCss = JSON.stringify(buildChannelCss(DEFAULT_WEB_UI_SETTINGS).split(":root {")[0].trimEnd());
  const previewChannelName = JSON.stringify(SETTINGS_PREVIEW_CHANNEL_NAME);
  const previewTopic = JSON.stringify(SETTINGS_PREVIEW_TOPIC);
  const previewMessageValue = JSON.stringify(SETTINGS_PREVIEW_MESSAGE_VALUE);

  return `<script>
window.addEventListener("DOMContentLoaded", function () {
  var presets = { light: ${lightPreset}, dark: ${darkPreset} };
  var colorFieldNames = ${colorFieldNames};
  var channelShellTemplate = ${channelShellTemplate};
  var previewMessageEntries = ${previewMessageEntries};
  var defaultPreviewSettings = ${defaultPreviewSettings};
  var channelBaseCss = ${previewChannelCss};
  var previewChannelName = ${previewChannelName};
  var previewTopic = ${previewTopic};
  var previewMessageValue = ${previewMessageValue};
  var presetButtons = document.querySelectorAll("[data-theme-preset]");
  var themePreviewUpdateScheduled = false;

  function buildLinkBackgroundColor(accentColor) {
    var red = Number.parseInt(accentColor.slice(1, 3), 16);
    var green = Number.parseInt(accentColor.slice(3, 5), 16);
    var blue = Number.parseInt(accentColor.slice(5, 7), 16);
    return "rgba(" + red + "," + green + "," + blue + ",0.2)";
  }

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
    return [channelBaseCss, ":root {\\n  " + rootLines.join("\\n  ") + "\\n}", "body,\\ninput,\\nbutton,\\ntextarea {\\n  " + typographyLines.join("\\n  ") + "\\n}"].join("\\n\\n");
  }

  function escapePreviewHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function getPreviewSettings() {
    var settings = Object.assign({}, defaultPreviewSettings);
    var fontFamilyInput = document.querySelector('input[name="fontFamily"]');
    var fontSizeInput = document.querySelector('input[name="fontSizePx"]');
    var checkedDisplayOrder = document.querySelector('input[name="displayOrder"]:checked');
    settings.fontFamily = fontFamilyInput && fontFamilyInput.value.trim() ? fontFamilyInput.value : defaultPreviewSettings.fontFamily;
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
    var orderedEntries = settings.displayOrder === "asc" ? previewMessageEntries.slice() : previewMessageEntries.slice().reverse();
    return orderedEntries.map(function (entry) {
      return entry.isDimmed ? '<div class="msg-dimmed">' + entry.html + "</div>" : "<div>" + entry.html + "</div>";
    }).join("\\n");
  }

  function buildPreviewMessagesDocument(settings) {
    return "<!DOCTYPE html><html><head>" + '<meta charset="utf-8">' + '<meta name="viewport" content="width=device-width, user-scalable=no">' + "<title>IRC: " + escapePreviewHtml(previewChannelName) + " / " + escapePreviewHtml(previewTopic) + "</title>" + "<style>" + buildPreviewChannelCss(settings) + "</style>" + "</head><body class=\\"channel-messages-page\\">" + '<div id="channel-messages-shell" class="channel-messages-shell">' + buildPreviewMessagesMarkup(settings) + "</div>" + "</body></html>";
  }

  function buildPreviewComposerDocument(settings) {
    return "<!DOCTYPE html><html><head>" + '<meta charset="utf-8">' + '<meta name="viewport" content="width=device-width, user-scalable=no">' + "<title>IRC: " + escapePreviewHtml(previewChannelName) + "/Composer</title>" + "<style>" + buildPreviewChannelCss(settings) + "</style>" + '</head><body class="channel-composer-page"><div class="channel-composer-shell">' + '<form action="#preview" method="POST" class="message-form">' + '<a href="#preview" class="channel-list-link" aria-label="チャンネル一覧へ戻る" title="チャンネル一覧へ戻る">☰</a>' + '<input type="text" name="message" size="10" value="' + escapePreviewHtml(previewMessageValue) + '" class="message-input" autocomplete="off">' + '<input type="submit" value="送信" class="submit-button">' + "</form></div></body></html>";
  }

  function buildPreviewFrameHtml(kind, title, documentHtml) {
    return '<iframe class="channel-frame channel-frame--' + kind + '" title="' + escapePreviewHtml(title) + '" sandbox srcdoc="' + escapePreviewHtml(documentHtml) + '"></iframe>';
  }

  function buildPreviewShellDocument(settings) {
    var messagesFrameHtml = buildPreviewFrameHtml("messages", "チャンネル表示プレビュー", buildPreviewMessagesDocument(settings));
    var composerFrameHtml = buildPreviewFrameHtml("composer", "送信フォームプレビュー", buildPreviewComposerDocument(settings));
    var frameContent = settings.displayOrder === "asc" ? messagesFrameHtml + "\\n" + composerFrameHtml : composerFrameHtml + "\\n" + messagesFrameHtml;
    return channelShellTemplate.replace("{{WEB_APP_HEAD}}", "").replace("{{CSS}}", buildPreviewChannelCss(settings)).replace("{{THEME_CSS_LINK}}", "").replace("{{CHANNEL}}", escapePreviewHtml(previewChannelName)).replace("{{TOPIC}}", escapePreviewHtml(previewTopic)).replace("{{FRAME_CONTENT}}", frameContent);
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

/**
 * チャンネル一覧ページを構築する。
 */
export function buildChannelListPage(
  channels: string[],
  nick: string,
  serverName: string,
  connected: boolean,
  basePath: string,
  showLogout = false,
  showSettings = false,
  flashMessage = "",
  flashTone: FlashTone = "info",
  configFormValues: { nick: string; autojoin: string } = { nick: "", autojoin: "" },
): string {
  const flashHtml = renderFlashMessage(flashMessage, flashTone);
  const adminBrandHtml = renderAdminBrand(`${basePath}/assets/apricot-logo.png`);
  const webAppHeadHtml = buildWebAppHead(basePath, "#f7f8f9");
  const nickForm = buildNickChangeForm(nick, basePath);
  const joinForm = buildJoinForm(basePath);
  const configPanelHtml = buildPersistedProxyConfigSection(basePath, configFormValues);
  const channelLinksHtml = (channels.length === 0
    ? `<div class="admin-empty-state"><h3>参加中のチャンネルはありません</h3><p>JOIN 済みチャンネルはここに表示されます。下のフォームから参加できます。</p></div>`
    : channels.map((channel) => `
<div class="admin-list-item">
  <a href="${basePath}/${encodeURIComponent(channel)}" class="admin-list-item__link">
    <span class="admin-list-item__title">${escapeHtml(channel)}</span>
    <span class="admin-list-item__meta">チャンネル画面を開く</span>
  </a>
  <form action="${basePath}/leave" method="POST">
    <input type="hidden" name="channel" value="${escapeHtml(channel)}">
    <button type="submit" class="admin-button admin-button--danger">チャンネル離脱</button>
  </form>
</div>`).join("\n")) + `\n${joinForm}`;
  const actionParts: string[] = [];
  if (showSettings) {
    actionParts.push(`<a href="${basePath}/settings" class="admin-button admin-button--subtle">設定</a>`);
  }
  if (showLogout) {
    actionParts.push(renderAdminLogoutForm(basePath));
  }
  const statusClass = connected ? "admin-status-badge--success" : "admin-status-badge--danger";
  const statusText = connected ? "接続中" : "切断中";
  const channelCountText = channels.length === 0 ? "参加中チャンネルはありません" : `${channels.length} 件のチャンネルに参加中`;

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
    .replace("{{CHANNEL_LINKS}}", channelLinksHtml)
    .replace("{{CONFIG_PANEL}}", configPanelHtml);
}

/**
 * 設定画面を構築する。
 */
export function buildSettingsPage(
  nick: string,
  serverName: string,
  basePath: string,
  webUiSettings: WebUiSettings,
  errorMessage = "",
): string {
  const isAscendingOrder = webUiSettings.displayOrder === "asc";
  const adminBrandHtml = renderAdminBrand(`${basePath}/assets/apricot-logo.png`);
  const webAppHeadHtml = buildWebAppHead(basePath, "#f7f8f9");
  const topActionsHtml = `<a href="${basePath}/" class="admin-button admin-button--subtle">チャンネル一覧へ戻る</a>${renderAdminLogoutForm(basePath)}`;

  return SETTINGS_TEMPLATE
    .replace("{{CSS}}", buildAdminCss())
    .replace("{{WEB_APP_HEAD}}", webAppHeadHtml)
    .replace("{{ADMIN_BRAND}}", adminBrandHtml)
    .replace("{{NICK}}", escapeHtml(nick))
    .replace("{{SERVER_NAME}}", escapeHtml(serverName))
    .replace("{{TOP_ACTIONS}}", topActionsHtml)
    .replace("{{ERROR}}", renderSettingsError(errorMessage))
    .replace("{{ACTION_URL}}", `${basePath}/settings`)
    .replace("{{COLOR_PREVIEW}}", buildSettingsPreviewHtml(webUiSettings))
    .replace("{{PRESET_CONTROLS}}", renderThemePresetControls())
    .replace("{{FONT_FAMILY}}", escapeHtml(webUiSettings.fontFamily))
    .replace("{{FONT_SIZE_PX}}", String(webUiSettings.fontSizePx))
    .replace("{{COLOR_FIELDS}}", renderThemeColorFields(webUiSettings))
    .replace("{{DISPLAY_ORDER_ASC_CHECKED}}", isAscendingOrder ? "checked" : "")
    .replace("{{DISPLAY_ORDER_DESC_CHECKED}}", isAscendingOrder ? "" : "checked")
    .replace("{{ENABLE_INLINE_URL_PREVIEW_CHECKED}}", webUiSettings.enableInlineUrlPreview ? "checked" : "")
    .replace("{{EXTRA_CSS}}", escapeHtml(webUiSettings.extraCss))
    .replace("{{HIGHLIGHT_KEYWORDS}}", escapeHtml(webUiSettings.highlightKeywords))
    .replace("{{DIM_KEYWORDS}}", escapeHtml(webUiSettings.dimKeywords))
    .replace("{{SETTINGS_SCRIPT}}", renderThemePresetScript());
}

/**
 * チャンネルシェルページを構築する。
 */
export function buildChannelPage(
  channel: string,
  topic: string,
  basePath: string,
  webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
  themeCssHref = "",
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

  return CHANNEL_SHELL_TEMPLATE
    .replace("{{WEB_APP_HEAD}}", buildWebAppHead(basePath, webUiSettings.surfaceColor))
    .replace("{{CSS}}", buildChannelCss(webUiSettings))
    .replace("{{THEME_CSS_LINK}}", themeCssHref ? `<link rel="stylesheet" href="${themeCssHref}">` : "")
    .replace("{{CHANNEL}}", escapeHtml(channel))
    .replace("{{TOPIC}}", escapeHtml(topic))
    .replace("{{FRAME_CONTENT}}", frameContent);
}

/**
 * メッセージフラグメントを描画する。
 */
export function buildChannelMessagesFragment(
  channel: string,
  messages: StoredMessage[],
  selfNick: string,
  timezoneOffset: number,
  webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
  sinceSequence = 0,
): RenderedChannelMessagesFragment {
  const sequenceRange = messages.length === 0
    ? { latestSequence: 0, oldestSequence: 0 }
    : { latestSequence: messages[messages.length - 1].sequence, oldestSequence: messages[0].sequence };
  const canRenderDelta = sinceSequence > 0
    && sinceSequence <= sequenceRange.latestSequence
    && sinceSequence >= sequenceRange.oldestSequence - 1;
  const fragmentMode = canRenderDelta ? "delta" : "full";
  const fragmentStartSequence = fragmentMode === "delta" ? sinceSequence : 0;
  const sourceMessages = fragmentMode === "delta"
    ? messages.filter((message) => message.sequence > sinceSequence)
    : messages;
  const orderedMessages = webUiSettings.displayOrder === "asc" ? [...sourceMessages] : [...sourceMessages].reverse();
  const highlightKeywords = parseKeywords(webUiSettings.highlightKeywords);
  const dimKeywords = parseKeywords(webUiSettings.dimKeywords);
  const linesHtml = orderedMessages.map((message) => {
    const isDimmed = dimKeywords.length > 0 && dimKeywords.some((keyword) => message.text.toLowerCase().includes(keyword.toLowerCase()));
    const divClass = isDimmed ? ' class="msg-dimmed"' : "";
    const renderKey = `${channel.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}-${message.sequence}`;
    return `<div data-message-sequence="${message.sequence}"${divClass}>${renderMessage(message, selfNick, timezoneOffset, highlightKeywords, webUiSettings, renderKey)}</div>`;
  }).join("\n");
  const popupHtml = webUiSettings.enableInlineUrlPreview || fragmentMode === "delta"
    ? ""
    : `<div id="url-preview-popup" class="url-preview-popup" hidden>
  <div data-preview-popup-rich class="url-preview-popup__rich" hidden></div>
  <div data-preview-popup-embed class="url-embed url-embed--popup">
    <img data-preview-popup-image src="" alt="URL preview" class="url-embed__image" loading="lazy">
    <span class="url-embed__meta">
      <span data-preview-popup-site class="url-embed__site"></span>
      <span data-preview-popup-title class="url-embed__title"></span>
      <span data-preview-popup-description class="url-embed__description"></span>
    </span>
  </div>
 </div>`;

  return {
    html: linesHtml + popupHtml,
    latestSequence: sequenceRange.latestSequence,
    startSequence: fragmentStartSequence,
    mode: fragmentMode,
  };
}

/**
 * メッセージページ全体を構築する。
 */
export function buildChannelMessagesPage(
  channel: string,
  topic: string,
  messages: StoredMessage[],
  selfNick: string,
  timezoneOffset: number,
  webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
  channelSequence = 0,
  themeCssHref = "",
): string {
  const messagesHtml = buildChannelMessagesFragment(
    channel,
    messages,
    selfNick,
    timezoneOffset,
    webUiSettings,
  ).html;
  const reloadButton = webUiSettings.displayOrder === "desc"
    ? '<button type="button" class="floating" onclick="void refreshMessages();">再読込</button>'
    : "";
  const scriptParts: string[] = [
    buildMessagesPageScript(channel, webUiSettings, channelSequence),
    buildRichEmbedScript(),
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
 * Composer ページを構築する。
 */
export function buildChannelComposerPage(
  channel: string,
  basePath: string,
  messageValue = "",
  flashMessage = "",
  flashTone: FlashTone = "info",
  webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
  shouldReloadMessages = false,
  themeCssHref = "",
): string {
  const actionUrl = `${basePath}/${encodeURIComponent(channel)}/composer`;
  const channelListLink = `<a href="${basePath}/" target="_top" class="channel-list-link" aria-label="チャンネル一覧へ戻る" title="チャンネル一覧へ戻る">☰</a>`;

  return CHANNEL_COMPOSER_TEMPLATE
    .replace("{{CSS}}", buildChannelCss(webUiSettings))
    .replace("{{THEME_CSS_LINK}}", themeCssHref ? `<link rel="stylesheet" href="${themeCssHref}">` : "")
    .replace("{{CHANNEL}}", escapeHtml(channel))
    .replace("{{ACTION_URL}}", actionUrl)
    .replace("{{CHANNEL_LIST_LINK}}", channelListLink)
    .replace("{{FLASH_MESSAGE}}", renderFlashMessage(flashMessage, flashTone))
    .replace("{{MESSAGE_VALUE}}", escapeHtml(messageValue))
    .replace("{{ON_LOAD_SCRIPT}}", buildComposerOnLoadScript(shouldReloadMessages));
}
