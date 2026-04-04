/**
 * Web interface module.
 * Provides an HTTP-based IRC chat interface similar to plum's imode module.
 *
 * Features:
 *   - Channel list page
 *   - Per-channel message view with send form
 *   - Auto-refresh (30s)
 *   - Dark/light mode
 *   - Message history with timestamps
 *   - IRC event logging (JOIN/PART/QUIT/NICK/TOPIC etc.)
 */

import { defineModule } from "../module-system";
import { extractNick, isChannel } from "../irc-parser";
import CSS from "../templates/style.css";
import ADMIN_CSS from "../templates/admin-style.css";
import CHANNEL_TEMPLATE from "../templates/channel.html";
import CHANNEL_LIST_TEMPLATE from "../templates/channel-list.html";
import SETTINGS_TEMPLATE from "../templates/settings.html";

// ---------------------------------------------------------------------------
// Message storage
// ---------------------------------------------------------------------------

export interface StoredMessage {
  time: number; // Unix ms
  type: "privmsg" | "notice" | "join" | "part" | "quit" | "kick" | "nick" | "topic" | "mode" | "self";
  nick: string;
  text: string;
}

/**
 * JSON-serializable snapshot of per-channel web logs keyed by lowercase channel.
 */
export type PersistedWebLogs = Record<string, StoredMessage[]>;
export type WebDisplayOrder = "asc" | "desc";

export interface WebUiSettings {
  fontFamily: string;
  fontSizePx: number;
  textColor: string;
  surfaceColor: string;
  surfaceAltColor: string;
  accentColor: string;
  displayOrder: WebDisplayOrder;
  extraCss: string;
}

const DEFAULT_maxLines = 200;

export const DEFAULT_WEB_UI_SETTINGS: WebUiSettings = {
  fontFamily: "\"Hiragino Kaku Gothic ProN\", \"Noto Sans JP\", sans-serif",
  fontSizePx: 16,
  textColor: "#000000",
  surfaceColor: "#FFFFFF",
  surfaceAltColor: "#EDF3FE",
  accentColor: "#0B5FFF",
  displayOrder: "desc",
  extraCss: "",
};

type MessageBufferStore = Map<string, StoredMessage[]>;
type PersistLogsCallback = (logs: PersistedWebLogs) => Promise<void>;

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

function renderSettingsError(errorMessage: string): string {
  return errorMessage
    ? `<div class="admin-message admin-message--danger" role="alert"><strong>設定を保存できませんでした。</strong><span>${escapeHtml(errorMessage)}</span></div>`
    : "";
}

function renderLogoutForm(basePath: string): string {
  return `<form action="${basePath}/logout" method="POST"><input type="submit" value="Logout" class="logout-button"></form>`;
}

function renderAdminLogoutForm(basePath: string): string {
  return `<form action="${basePath}/logout" method="POST"><button type="submit" class="admin-button admin-button--subtle">Logout</button></form>`;
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
  const rootLines: string[] = [];
  if (settings.surfaceColor !== DEFAULT_WEB_UI_SETTINGS.surfaceColor) {
    rootLines.push(`--rowcolor0: ${settings.surfaceColor};`);
  }
  if (settings.surfaceAltColor !== DEFAULT_WEB_UI_SETTINGS.surfaceAltColor) {
    rootLines.push(`--rowcolor1: ${settings.surfaceAltColor};`);
  }
  if (settings.textColor !== DEFAULT_WEB_UI_SETTINGS.textColor) {
    rootLines.push(`--textcolor: ${settings.textColor};`);
  }
  if (settings.accentColor !== DEFAULT_WEB_UI_SETTINGS.accentColor) {
    rootLines.push(`--accent-link: ${settings.accentColor};`);
    rootLines.push(`--border-color: ${settings.accentColor};`);
    rootLines.push(`--button-bg: ${settings.accentColor};`);
  }

  const typographyLines: string[] = [];
  if (settings.fontFamily !== DEFAULT_WEB_UI_SETTINGS.fontFamily) {
    typographyLines.push(`font-family: ${settings.fontFamily};`);
  }
  if (settings.fontSizePx !== DEFAULT_WEB_UI_SETTINGS.fontSizePx) {
    typographyLines.push(`font-size: ${settings.fontSizePx}px;`);
  }

  const blocks: string[] = [];
  if (rootLines.length > 0) {
    blocks.push(`:root {\n  ${rootLines.join("\n  ")}\n}`);
  }
  if (typographyLines.length > 0) {
    blocks.push(`body,\ninput,\nbutton,\ntextarea {\n  ${typographyLines.join("\n  ")}\n}`);
  }

  const extraCss = settings.extraCss.trim();
  return [CSS, ...blocks, extraCss].filter(Boolean).join("\n\n");
}

/**
 * Escape text for HTML, linkifying any URLs found in the raw string.
 *
 * URLs are extracted from the raw (unescaped) text first, so the href
 * attribute contains the real URL (not &amp;-encoded).  The surrounding
 * non-URL text and the link label are then HTML-escaped safely.
 */
function renderText(raw: string): string {
  const urlRe = /(https?:\/\/[^\s<>"]+)/g;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = urlRe.exec(raw)) !== null) {
    result += escapeHtml(raw.slice(last, m.index));
    const url = m[1];
    let hostname: string;
    try { hostname = new URL(url).hostname; } catch { hostname = url; }
    result += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(hostname)}</a>`;
    last = m.index + url.length;
  }
  result += escapeHtml(raw.slice(last));
  return result;
}

function formatTime(ms: number, offsetHours: number): string {
  const d = new Date(ms + offsetHours * 3_600_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function renderMessage(m: StoredMessage, selfNick: string, offsetHours: number): string {
  const ts = `<span class="timestamp">${formatTime(m.time, offsetHours)}</span>`;
  const isSelf = m.nick.toLowerCase() === selfNick.toLowerCase();
  const nickClass = isSelf ? "username-self" : "username-other";

  switch (m.type) {
    case "privmsg":
      return `${ts} <span class="${nickClass}">${escapeHtml(m.nick)}&gt;</span> ${renderText(m.text)}`;
    case "notice":
      return `${ts} <span class="${nickClass}">(${escapeHtml(m.nick)})</span> ${renderText(m.text)}`;
    case "self":
      return `${ts} <span class="username-self">${escapeHtml(m.nick)}&gt;</span> ${renderText(m.text)}`;
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
      return `${ts} ${renderText(m.text)}`;
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
): string {
  const joinForm = `
<form action="${basePath}/join" method="POST" class="admin-inline-form">
  <input type="text" name="channel" placeholder="#channel" class="admin-input" autocomplete="off">
  <button type="submit" class="admin-button admin-button--primary">Join channel</button>
</form>`;
  const chLinks = (channels.length === 0
    ? `<div class="admin-empty-state"><h3>No channels joined</h3><p>JOIN 済みチャンネルはここに表示されます。下のフォームから参加できます。</p></div>`
    : channels
        .map((ch) => `
<div class="admin-list-item">
  <a href="${basePath}/${encodeURIComponent(ch)}" class="admin-list-item__link">
    <span class="admin-list-item__title">${escapeHtml(ch)}</span>
    <span class="admin-list-item__meta">Open channel view</span>
  </a>
  <form action="${basePath}/leave" method="POST">
    <input type="hidden" name="channel" value="${escapeHtml(ch)}">
    <button type="submit" class="admin-button admin-button--danger">Leave</button>
  </form>
</div>`)
        .join("\n")) + `\n${joinForm}`;
  const actionParts: string[] = [];
  if (showSettings) {
    actionParts.push(`<a href="${basePath}/settings" class="admin-button admin-button--subtle">Settings</a>`);
  }
  if (showLogout) {
    actionParts.push(renderAdminLogoutForm(basePath));
  }
  const statusClass = connected ? "admin-status-badge--success" : "admin-status-badge--danger";
  const statusText = connected ? "Connected" : "Disconnected";
  const channelCountText = channels.length === 0
    ? "参加中チャンネルはありません"
    : `${channels.length} channel${channels.length === 1 ? "" : "s"} joined`;

  return CHANNEL_LIST_TEMPLATE
    .replace("{{CSS}}", buildAdminCss())
    .replace("{{STATUS_CLASS}}", statusClass)
    .replace("{{STATUS_TEXT}}", statusText)
    .replace("{{STATUS_ICON}}", connected ? "&#x1f7e2;" : "&#x1f534;")
    .replace("{{NICK}}", escapeHtml(nick))
    .replace("{{SERVER_NAME}}", escapeHtml(serverName))
    .replace("{{CHANNEL_COUNT}}", escapeHtml(channelCountText))
    .replace("{{TOP_ACTIONS}}", actionParts.join(""))
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
  const topActionsHtml = `<a href="${basePath}/" class="admin-button admin-button--subtle">Back to channels</a>${renderAdminLogoutForm(basePath)}`;
  const errorHtml = renderSettingsError(errorMessage);

  return SETTINGS_TEMPLATE
    .replace("{{CSS}}", buildAdminCss())
    .replace("{{NICK}}", escapeHtml(nick))
    .replace("{{SERVER_NAME}}", escapeHtml(serverName))
    .replace("{{TOP_ACTIONS}}", topActionsHtml)
    .replace("{{ERROR}}", errorHtml)
    .replace("{{ACTION_URL}}", `${basePath}/settings`)
    .replace("{{FONT_FAMILY}}", escapeHtml(webUiSettings.fontFamily))
    .replace("{{FONT_SIZE_PX}}", String(webUiSettings.fontSizePx))
    .replace("{{TEXT_COLOR}}", renderColorValue(webUiSettings.textColor))
    .replace("{{SURFACE_COLOR}}", renderColorValue(webUiSettings.surfaceColor))
    .replace("{{SURFACE_ALT_COLOR}}", renderColorValue(webUiSettings.surfaceAltColor))
    .replace("{{ACCENT_COLOR}}", renderColorValue(webUiSettings.accentColor))
    .replace("{{DISPLAY_ORDER_ASC_CHECKED}}", isAscendingOrder ? "checked" : "")
    .replace("{{DISPLAY_ORDER_DESC_CHECKED}}", isAscendingOrder ? "" : "checked")
    .replace("{{EXTRA_CSS}}", escapeHtml(webUiSettings.extraCss));
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

  const module = defineModule("web", (m) => {
    m.on("ss_privmsg", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      const text = msg.params[1] || "";
      const channel = isChannel(target) ? target : nick; // DM keyed by sender nick
      await appendMessage(channel, { time: Date.now(), type: "privmsg", nick, text });
      return msg;
    });

    m.on("ss_notice", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      const text = msg.params[1] || "";
      const channel = isChannel(target) ? target : nick;
      await appendMessage(channel, { time: Date.now(), type: "notice", nick, text });
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
    const buf = getBuffer(channel);
    const ordered = webUiSettings.displayOrder === "asc" ? [...buf] : [...buf].reverse();
    const lines = ordered
      .map((msg, i) => {
        const cls = i % 2 === 0 ? "color0" : "color1";
        return `<div class="${cls}">${renderMessage(msg, selfNick, timezoneOffset)}</div>`;
      })
      .join("\n");

    const actionUrl = `${basePath}/${encodeURIComponent(channel)}`;
    const channelListLink = `<a href="${basePath}/" class="channel-list-link" aria-label="Back to channels" title="Back to channels">☰</a>`;
    const inputBarPosition = webUiSettings.displayOrder === "asc" ? "bottom" : "top";
    const reloadButton = webUiSettings.displayOrder === "desc"
      ? '<button type="button" class="floating" onclick="location.reload();">Reload</button>'
      : "";
    const contentPadding = webUiSettings.displayOrder === "asc" ? "padding-bottom:45px;" : "padding-top:45px;";

    return CHANNEL_TEMPLATE
      .replace("{{CSS}}", buildChannelCss(webUiSettings))
      .replace(
        "{{LOGOUT_FORM}}",
        showLogout
          ? `<div class="web-auth-bar">${renderLogoutForm(basePath)}</div>`
          : ""
      )
      .replace("{{CHANNEL}}", escapeHtml(channel))
      .replace("{{TOPIC}}", escapeHtml(topic))
      .replace("{{ACTION_URL}}", actionUrl)
      .replace("{{CHANNEL_LIST_LINK}}", channelListLink)
      .replace("{{INPUT_BAR_POSITION}}", inputBarPosition)
      .replace("{{RELOAD_BUTTON}}", reloadButton)
      .replace("{{CONTENT_PADDING}}", contentPadding)
      .replace("{{MESSAGES}}", lines);
  }

  /**
   * Adds a locally generated message and persists the latest snapshot.
   */
  async function recordSelfMessage(channel: string, nick: string, text: string): Promise<void> {
    await appendMessage(channel, { time: Date.now(), type: "self", nick, text });
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

  return { module, buildChannelPage, recordSelfMessage, getChannelTopic, snapshotLogs, hydrateLogs, getChannelLogs };
}
