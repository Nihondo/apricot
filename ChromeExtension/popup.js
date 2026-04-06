const STORAGE_KEY = "apricotPostSettings";

document.addEventListener("DOMContentLoaded", async () => {
  const elementMap = collectElements();
  const state = {
    isPosting: false,
    hasPosted: false,
  };

  registerEventListeners(elementMap, state);
  await initializePopup(elementMap);
});

function collectElements() {
  return {
    apiBaseUrlInput: document.getElementById("apiBaseUrl"),
    proxyIdInput: document.getElementById("proxyId"),
    channelInput: document.getElementById("channel"),
    apiKeyInput: document.getElementById("apiKey"),
    pageInfoInput: document.getElementById("pageInfo"),
    selectedTextArea: document.getElementById("selectedText"),
    additionalTextArea: document.getElementById("additionalText"),
    messagePreviewArea: document.getElementById("messagePreview"),
    saveButton: document.getElementById("saveButton"),
    copyButton: document.getElementById("copyButton"),
    postButton: document.getElementById("postButton"),
    statusBox: document.getElementById("status"),
  };
}

function registerEventListeners(elementMap, state) {
  const { selectedTextArea, additionalTextArea, saveButton, copyButton, postButton } = elementMap;

  saveButton.addEventListener("click", async () => {
    const result = validateSettings(readSettings(elementMap));
    if (!result.ok) {
      showStatus(elementMap, result.error, true);
      return;
    }

    await persistSettings(result.value);
    showStatus(elementMap, "設定を保存しました");
  });

  copyButton.addEventListener("click", async () => {
    await copyMessageToClipboard(elementMap);
  });

  postButton.addEventListener("click", async () => {
    await postMessageToApricot(elementMap, state);
  });

  [selectedTextArea, additionalTextArea].forEach((element) => {
    element.addEventListener("input", () => {
      updateMessagePreview(elementMap);
    });
  });

  document.addEventListener("keydown", async (event) => {
    const canSubmit = (event.metaKey || event.ctrlKey) && event.key === "Enter";
    if (!canSubmit || state.isPosting || state.hasPosted) {
      return;
    }

    event.preventDefault();
    await postMessageToApricot(elementMap, state);
  });
}

async function initializePopup(elementMap) {
  try {
    const [settings, tabInfo, selectedText] = await Promise.all([
      loadSettings(),
      loadCurrentTabInfo(),
      loadSelectedText(),
    ]);

    writeSettings(elementMap, settings);
    elementMap.pageInfoInput.value = normalizeToNfc(buildPageInfoText(tabInfo));
    elementMap.selectedTextArea.value = normalizeToNfc(selectedText);
    updateMessagePreview(elementMap);
    elementMap.additionalTextArea.focus();
  } catch (error) {
    console.error("初期化に失敗:", error);
    showStatus(elementMap, "初期化に失敗しました", true);
  }
}

async function loadSettings() {
  const storedItems = await chrome.storage.local.get(STORAGE_KEY);
  return {
    apiBaseUrl: storedItems[STORAGE_KEY]?.apiBaseUrl || "",
    proxyId: storedItems[STORAGE_KEY]?.proxyId || "",
    channel: storedItems[STORAGE_KEY]?.channel || "",
    apiKey: storedItems[STORAGE_KEY]?.apiKey || "",
  };
}

function readSettings(elementMap) {
  return {
    apiBaseUrl: elementMap.apiBaseUrlInput.value.trim(),
    proxyId: elementMap.proxyIdInput.value.trim(),
    channel: elementMap.channelInput.value.trim(),
    apiKey: elementMap.apiKeyInput.value.trim(),
  };
}

function writeSettings(elementMap, settings) {
  elementMap.apiBaseUrlInput.value = settings.apiBaseUrl;
  elementMap.proxyIdInput.value = settings.proxyId;
  elementMap.channelInput.value = settings.channel;
  elementMap.apiKeyInput.value = settings.apiKey;
}

async function persistSettings(settings) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      apiBaseUrl: trimTrailingSlash(settings.apiBaseUrl),
      proxyId: settings.proxyId,
      channel: settings.channel,
      apiKey: settings.apiKey,
    },
  });
}

async function loadCurrentTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || {};
}

async function loadSelectedText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return "";
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => window.getSelection()?.toString() || "",
    });
    return results[0]?.result || "";
  } catch (error) {
    console.error("選択テキストの取得に失敗:", error);
    return "";
  }
}

function buildPageInfoText(tabInfo) {
  const titleText = sanitizeInlineText(tabInfo.title || "");
  const urlText = sanitizeInlineText(tabInfo.url || "");
  return [titleText, urlText].filter(Boolean).join(" ");
}

function updateMessagePreview(elementMap) {
  elementMap.messagePreviewArea.value = composeMessageText({
    pageInfo: elementMap.pageInfoInput.value,
    selectedText: elementMap.selectedTextArea.value,
    additionalText: elementMap.additionalTextArea.value,
  });
}

function composeMessageText({ pageInfo, selectedText, additionalText }) {
  const pageInfoText = sanitizeInlineText(pageInfo);
  const selectedTextValue = sanitizeInlineText(selectedText);
  const additionalTextValue = sanitizeInlineText(additionalText);

  const messageParts = [];
  if (pageInfoText) {
    messageParts.push(pageInfoText);
  }
  if (selectedTextValue) {
    messageParts.push(`>${selectedTextValue}`);
  }
  if (additionalTextValue) {
    messageParts.push(additionalTextValue);
  }

  return normalizeToNfc(messageParts.join(" ").trim());
}

async function copyMessageToClipboard(elementMap) {
  const messageText = elementMap.messagePreviewArea.value.trim();
  if (!messageText) {
    showStatus(elementMap, "コピーするメッセージがありません", true);
    return false;
  }

  try {
    await navigator.clipboard.writeText(messageText);
    showStatus(elementMap, "メッセージをコピーしました");
    return true;
  } catch (error) {
    console.error("コピーに失敗:", error);
    showStatus(elementMap, "コピーに失敗しました", true);
    return false;
  }
}

async function postMessageToApricot(elementMap, state) {
  if (state.isPosting || state.hasPosted) {
    return;
  }

  const settingsResult = validateSettings(readSettings(elementMap));
  if (!settingsResult.ok) {
    showStatus(elementMap, settingsResult.error, true);
    return;
  }

  const messageText = elementMap.messagePreviewArea.value.trim();
  if (!messageText) {
    showStatus(elementMap, "送信メッセージが空です", true);
    return;
  }

  await persistSettings(settingsResult.value);
  setPostingState(elementMap, state, true);

  try {
    const endpointUrl = buildApiEndpoint(settingsResult.value);
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settingsResult.value.apiKey}`,
      },
      body: JSON.stringify({
        channel: settingsResult.value.channel,
        message: messageText,
      }),
    });

    if (!response.ok) {
      const errorMessage = await readErrorMessage(response);
      throw new Error(errorMessage);
    }

    state.hasPosted = true;
    state.isPosting = false;
    elementMap.postButton.disabled = true;
    elementMap.postButton.textContent = "投稿完了";

    const hasCopied = await copyMessageToClipboard(elementMap);
    showStatus(
      elementMap,
      hasCopied ? "投稿してコピーしました" : "投稿しました"
    );
  } catch (error) {
    console.error("投稿に失敗:", error);
    setPostingState(elementMap, state, false);
    showStatus(elementMap, error.message || "投稿に失敗しました", true);
  }
}

function setPostingState(elementMap, state, isPosting) {
  state.isPosting = isPosting;
  elementMap.postButton.disabled = isPosting || state.hasPosted;
  elementMap.postButton.textContent = isPosting ? "投稿中..." : "投稿";
}

function validateSettings(settings) {
  if (!settings.apiBaseUrl) {
    return { ok: false, error: "apricot URL を入力してください" };
  }

  try {
    new URL(settings.apiBaseUrl);
  } catch {
    return { ok: false, error: "apricot URL の形式が不正です" };
  }

  if (!settings.proxyId) {
    return { ok: false, error: "Proxy ID を入力してください" };
  }
  if (!settings.channel) {
    return { ok: false, error: "Channel を入力してください" };
  }
  if (!settings.apiKey) {
    return { ok: false, error: "API Key を入力してください" };
  }

  return {
    ok: true,
    value: {
      apiBaseUrl: trimTrailingSlash(settings.apiBaseUrl),
      proxyId: settings.proxyId,
      channel: settings.channel,
      apiKey: settings.apiKey,
    },
  };
}

function buildApiEndpoint(settings) {
  const baseUrl = trimTrailingSlash(settings.apiBaseUrl);
  const proxyId = encodeURIComponent(settings.proxyId);
  return `${baseUrl}/proxy/${proxyId}/api/post`;
}

async function readErrorMessage(response) {
  try {
    const responseJson = await response.json();
    if (typeof responseJson?.error === "string" && responseJson.error) {
      return responseJson.error;
    }
  } catch {
    return `HTTP ${response.status}`;
  }

  return `HTTP ${response.status}`;
}

function showStatus(elementMap, message, isError = false) {
  elementMap.statusBox.textContent = message;
  elementMap.statusBox.className = isError ? "status error" : "status success";
}

function sanitizeInlineText(value) {
  return normalizeToNfc(value).replace(/\s+/gu, " ").trim();
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function normalizeToNfc(value) {
  if (typeof value !== "string") {
    return "";
  }

  return typeof String.prototype.normalize === "function"
    ? value.normalize("NFC")
    : value;
}
