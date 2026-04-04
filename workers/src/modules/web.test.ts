import { describe, expect, it, vi } from "vitest";
import type { ModuleContext } from "../module-system";

vi.mock("../templates/admin-style.css", () => ({ default: "ADMIN_CSS" }));
vi.mock("../templates/style.css", () => ({ default: "" }));
vi.mock("../templates/channel.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{LOGOUT_FORM}}<div class=\"shell\">{{FRAME_CONTENT}}</div></body></html>",
}));
vi.mock("../templates/channel-messages.html", () => ({
  default: "<html><head><style>{{CSS}}</style><script>{{AUTO_SCROLL_SCRIPT}}</script></head><body>{{TOPIC_BLOCK}}{{MESSAGES}}{{RELOAD_BUTTON}}</body></html>",
}));
vi.mock("../templates/channel-composer.html", () => ({
  default: "<html><head><style>{{CSS}}</style><script>{{ON_LOAD_SCRIPT}}</script></head><body>{{FLASH_MESSAGE}}<form action=\"{{ACTION_URL}}\">{{CHANNEL_LIST_LINK}}<input name=\"message\" value=\"{{MESSAGE_VALUE}}\"><button>送信</button></form></body></html>",
}));
vi.mock("../templates/channel-list.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}<p>{{SERVER_NAME}} に {{NICK}} として参加</p>{{FLASH_MESSAGE}}{{NICK_FORM}}<div>{{STATUS_CLASS}}{{STATUS_TEXT}}{{CHANNEL_COUNT}}{{CHANNEL_LINKS}}</div><span>サーバー: {{SERVER_NAME}}</span><span>NICK: {{NICK}}</span></body></html>",
}));
vi.mock("../templates/settings.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}{{ERROR}}この設定はチャンネル画面にのみ適用されます。{{PRESET_CONTROLS}}<form action=\"{{ACTION_URL}}\"><input name=\"fontFamily\" value=\"{{FONT_FAMILY}}\"><input name=\"fontSizePx\" value=\"{{FONT_SIZE_PX}}\">{{COLOR_FIELDS}}<textarea>{{EXTRA_CSS}}</textarea>{{DISPLAY_ORDER_ASC_CHECKED}}{{DISPLAY_ORDER_DESC_CHECKED}}</form>{{SETTINGS_SCRIPT}}</body></html>",
}));

import {
  buildAdminCss,
  buildChannelCss,
  buildChannelListPage,
  buildSettingsPage,
  buildWebUiSettings,
  createWebModule,
  type PersistedWebLogs,
} from "./web";

function makeContext(overrides: Partial<ModuleContext> = {}): ModuleContext {
  return {
    userno: 0,
    connno: 0,
    sendToServer: async () => undefined,
    sendToClients: () => undefined,
    getProperty: () => undefined,
    nick: "apricot",
    channels: [],
    serverName: "irc.example.com",
    ...overrides,
  };
}

describe("createWebModule", () => {
  it("returns snapshot logs grouped by lowercase channel", async () => {
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#General", "hello"],
    });
    await web.module.handlers.get("ss_notice")?.(ctx, {
      prefix: "server.example.com",
      command: "NOTICE",
      params: ["#random", "maintenance"],
    });

    const snapshot = web.snapshotLogs();
    expect(Object.keys(snapshot).sort()).toEqual(["#general", "#random"]);
    expect(snapshot["#general"][0]).toMatchObject({
      type: "privmsg",
      nick: "alice",
      text: "hello",
    });
    expect(snapshot["#random"][0]).toMatchObject({
      type: "notice",
      text: "maintenance",
    });
  });

  it("hydrates logs and rebuilds the same visible channel contents", async () => {
    const source = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await source.module.handlers.get("ss_topic")?.(ctx, {
      prefix: "alice!user@host",
      command: "TOPIC",
      params: ["#general", "welcome topic"],
    });
    await source.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "hello world"],
    });

    const restored = createWebModule(new Map(), 0);
    restored.hydrateLogs(source.snapshotLogs());

    expect(restored.getChannelTopic("#general")).toBe("welcome topic");

    const html = restored.buildChannelMessagesPage(
      "#general",
      restored.getChannelTopic("#general"),
      "apricot",
    );

    expect(html).toContain("welcome topic");
    expect(html).toContain("hello world");
    expect(html).toContain("alice&gt;");
  });

  it("buildChannelPage desc: composer iframe is placed before messages iframe", async () => {
    const web = createWebModule(new Map(), 0);
    const html = web.buildChannelPage(
      "#general",
      "",
      "apricot",
      "/proxy/main/web",
      false,
      buildWebUiSettings({ displayOrder: "desc" })
    );

    const messagesFrameIndex = html.indexOf("channel-messages-frame");
    const composerFrameIndex = html.indexOf("channel-composer-frame");
    expect(composerFrameIndex).toBeLessThan(messagesFrameIndex);
    expect(html).toContain('src="/proxy/main/web/%23general/messages"');
    expect(html).toContain('src="/proxy/main/web/%23general/composer"');
  });

  it("buildChannelPage asc: messages iframe is placed before composer iframe", async () => {
    const web = createWebModule(new Map(), 0);
    const html = web.buildChannelPage(
      "#general",
      "",
      "apricot",
      "/proxy/main/web",
      false,
      buildWebUiSettings({ displayOrder: "asc" })
    );

    const messagesFrameIndex = html.indexOf("channel-messages-frame");
    const composerFrameIndex = html.indexOf("channel-composer-frame");
    expect(messagesFrameIndex).toBeLessThan(composerFrameIndex);
  });

  it("buildChannelMessagesPage asc: messages stay chronological and auto-scrolls to bottom", async () => {
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "first"],
    });
    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "second"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ displayOrder: "asc" })
    );
    const firstIdx = html.indexOf("first");
    const secondIdx = html.indexOf("second");
    expect(firstIdx).toBeLessThan(secondIdx); // 古い順（firstが上）
    expect(html).not.toContain("再読込");
    expect(html).toContain("scrollHeight");
  });

  it("buildChannelMessagesPage desc: messages are reversed and show the reload button", async () => {
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "first"],
    });
    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "second"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ displayOrder: "desc" })
    );
    const firstIdx = html.indexOf("first");
    const secondIdx = html.indexOf("second");
    expect(secondIdx).toBeLessThan(firstIdx); // 新しい順（secondが上）
    expect(html).toContain("再読込");
    expect(html).not.toContain("scrollHeight");
  });

  it("buildChannelComposerPage includes the list link and reloads messages after submit", () => {
    const web = createWebModule(new Map(), 0);
    const html = web.buildChannelComposerPage(
      "#general",
      "/proxy/main/web",
      "draft",
      "送信失敗",
      "danger",
      buildWebUiSettings(),
      true
    );

    expect(html).toContain('action="/proxy/main/web/%23general/composer"');
    expect(html).toContain('href="/proxy/main/web/"');
    expect(html).toContain("一覧");
    expect(html).toContain('value="draft"');
    expect(html).toContain("送信失敗");
    expect(html).toContain("channel-messages-frame");
    expect(html).toContain("location.reload()");
  });

  it("trims restored logs to the latest 200 messages", () => {
    const snapshot: PersistedWebLogs = {
      "#general": Array.from({ length: 250 }, (_, index) => ({
        time: index,
        type: "privmsg",
        nick: "alice",
        text: `msg-${index}`,
      })),
    };

    const web = createWebModule(new Map(), 0);
    web.hydrateLogs(snapshot);

    const restored = web.snapshotLogs();
    expect(restored["#general"]).toHaveLength(200);
    expect(restored["#general"][0].text).toBe("msg-50");
    expect(restored["#general"][199].text).toBe("msg-249");
  });

  it("builds channel CSS with overrides and extra CSS appended", () => {
    const css = buildChannelCss(buildWebUiSettings({
      fontFamily: "\"Fira Sans\", sans-serif",
      fontSizePx: 18,
      textColor: "#123456",
      surfaceColor: "#ABCDEF",
      surfaceAltColor: "#FEDCBA",
      accentColor: "#A6E22E",
      borderColor: "#0F0F0F",
      usernameColor: "#AA5500",
      timestampColor: "#00AA55",
      highlightColor: "#998800",
      buttonColor: "#001122",
      buttonTextColor: "#F0F0F0",
      selfColor: "#00CCFF",
      mutedTextColor: "#666666",
      extraCss: ".custom { color: red; }",
    }));

    expect(css).toContain("font-family: \"Fira Sans\", sans-serif;");
    expect(css).toContain("font-size: 18px;");
    expect(css).toContain("--textcolor: #123456;");
    expect(css).toContain("--border-color: #0F0F0F;");
    expect(css).toContain("--button-bg: #001122;");
    expect(css).toContain("--button-fg: #F0F0F0;");
    expect(css).toContain("--text-contrast-low: #666666;");
    expect(css).toContain("--link-bg: rgba(166,226,46,0.2);");
    expect(css).toContain(".custom { color: red; }");
  });

  it("builds fixed admin CSS separately from channel customization", () => {
    expect(buildAdminCss()).toBe("ADMIN_CSS");
  });

  it("builds the channel list page with repeated nick and server placeholders replaced", () => {
    const html = buildChannelListPage(
      ["#general"],
      "apricot",
      "irc.example.com",
      true,
      "/proxy/main/web"
    );

    expect(html).toContain("irc.example.com に apricot として参加");
    expect(html).toContain("サーバー: irc.example.com");
    expect(html).toContain("NICK: apricot");
    expect(html).toContain('action="/proxy/main/web/nick"');
    expect(html).toContain('name="nick"');
    expect(html).toContain('value="apricot"');
    expect(html).toContain("NICK変更");
    expect(html).toContain("変更");
    expect(html).not.toContain("{{SERVER_NAME}}");
    expect(html).not.toContain("{{NICK}}");
  });

  it("builds the channel list page with a danger flash message", () => {
    const html = buildChannelListPage(
      [],
      "apricot",
      "irc.example.com",
      false,
      "/proxy/main/web",
      false,
      false,
      "NICK変更に失敗しました: timeout waiting for server response",
      "danger"
    );

    expect(html).toContain("admin-message--danger");
    expect(html).toContain("NICK変更に失敗しました: timeout waiting for server response");
  });

  it("builds the settings page with current values and error text", () => {
    const html = buildSettingsPage(
      "apricot",
      "irc.example.com",
      "/proxy/main/web",
      buildWebUiSettings({ displayOrder: "asc", extraCss: "body { color: blue; }" }),
      "入力エラー"
    );

    expect(html).toContain("/proxy/main/web/settings");
    expect(html).toContain("body { color: blue; }");
    expect(html).toContain("この設定はチャンネル画面にのみ適用されます。");
    expect(html).toContain("入力エラー");
    expect(html).toContain('name="borderColor"');
    expect(html).toContain('name="mutedTextColor"');
    expect(html).toContain("ライトに戻す");
    expect(html).toContain("ダークに戻す");
    expect(html).toContain("リンク背景色はアクセント色から自動生成される");
    expect(html).toContain('"borderColor":"#0B5FFF"');
    expect(html).toContain("checked");
    expect(html).toContain("ADMIN_CSS");
  });
});
