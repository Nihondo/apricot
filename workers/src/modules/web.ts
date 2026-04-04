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
import CHANNEL_TEMPLATE from "../templates/channel.html";
import CHANNEL_LIST_TEMPLATE from "../templates/channel-list.html";

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

const DEFAULT_maxLines = 200;

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
  displayOrder: "asc" | "desc" = "desc"
): string {
  const chLinks = channels.length === 0
    ? "<p>No channels joined.</p>"
    : channels
        .map((ch) => `<a href="${basePath}/${encodeURIComponent(ch)}">${escapeHtml(ch)}</a>`)
        .join("\n");

  const ascActive = displayOrder === "asc" ? "active" : "";
  const descActive = displayOrder === "desc" ? "active" : "";
  const toggleHtml = `<div class="display-order-toggle">表示順: <form action="${basePath}/display-order" method="POST" style="display:inline;"><input type="hidden" name="order" value="asc"><button type="submit" class="toggle-button ${ascActive}">古い順</button></form> <form action="${basePath}/display-order" method="POST" style="display:inline;"><input type="hidden" name="order" value="desc"><button type="submit" class="toggle-button ${descActive}">新しい順</button></form></div>`;

  return CHANNEL_LIST_TEMPLATE
    .replace("{{CSS}}", CSS)
    .replace("{{STATUS_ICON}}", connected ? "&#x1f7e2;" : "&#x1f534;")
    .replace("{{NICK}}", escapeHtml(nick))
    .replace("{{SERVER_NAME}}", escapeHtml(serverName))
    .replace(
      "{{LOGOUT_FORM}}",
      showLogout
        ? `<div class="web-auth-bar"><form action="${basePath}/logout" method="POST"><input type="submit" value="Logout" class="logout-button"></form></div>`
        : ""
    )
    .replace("{{DISPLAY_ORDER_TOGGLE}}", toggleHtml)
    .replace("{{CHANNEL_LINKS}}", chLinks);
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
    displayOrder: "asc" | "desc" = "desc"
  ): string {
    const buf = getBuffer(channel);
    const ordered = displayOrder === "asc" ? [...buf] : [...buf].reverse();
    const lines = ordered
      .map((msg, i) => {
        const cls = i % 2 === 0 ? "color0" : "color1";
        return `<div class="${cls}">${renderMessage(msg, selfNick, timezoneOffset)}</div>`;
      })
      .join("\n");

    const actionUrl = `${basePath}/${encodeURIComponent(channel)}`;
    const inputBarPosition = displayOrder === "asc" ? "bottom" : "top";
    const reloadButton = displayOrder === "desc"
      ? '<button type="button" class="floating" onclick="location.reload();">Reload</button>'
      : "";
    const contentPadding = displayOrder === "asc" ? "padding-bottom:45px;" : "padding-top:45px;";

    return CHANNEL_TEMPLATE
      .replace("{{CSS}}", CSS)
      .replace(
        "{{LOGOUT_FORM}}",
        showLogout
          ? `<div class="web-auth-bar"><form action="${basePath}/logout" method="POST"><input type="submit" value="Logout" class="logout-button"></form></div>`
          : ""
      )
      .replace("{{CHANNEL}}", escapeHtml(channel))
      .replace("{{TOPIC}}", escapeHtml(topic))
      .replace("{{ACTION_URL}}", actionUrl)
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
