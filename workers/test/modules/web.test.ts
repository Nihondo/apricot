import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleContext } from "../../src/module-system";

const { resolveMessageEmbedMock } = vi.hoisted(() => ({
  resolveMessageEmbedMock: vi.fn(),
}));

vi.mock("../../src/templates/admin-style.css", () => ({ default: "ADMIN_CSS" }));
vi.mock("../../src/templates/style.css", () => ({ default: "" }));
vi.mock("../../src/modules/url-metadata", () => ({
  resolveMessageEmbed: resolveMessageEmbedMock,
}));
vi.mock("../../src/templates/channel.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body><div class=\"shell\">{{FRAME_CONTENT}}</div></body></html>",
}));
vi.mock("../../src/templates/channel-messages.html", () => ({
  default: "<html><head><style>{{CSS}}</style><script>{{AUTO_SCROLL_SCRIPT}}</script></head><body>{{MESSAGES}}{{RELOAD_BUTTON}}</body></html>",
}));
vi.mock("../../src/templates/channel-composer.html", () => ({
  default: "<html><head><style>{{CSS}}</style><script>{{ON_LOAD_SCRIPT}}</script></head><body>{{FLASH_MESSAGE}}<form action=\"{{ACTION_URL}}\">{{CHANNEL_LIST_LINK}}<input name=\"message\" value=\"{{MESSAGE_VALUE}}\"><button>送信</button></form></body></html>",
}));
vi.mock("../../src/templates/channel-list.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}<p>{{SERVER_NAME}} に {{NICK}} として参加</p>{{FLASH_MESSAGE}}{{NICK_FORM}}<div>{{STATUS_CLASS}}{{STATUS_TEXT}}{{CHANNEL_COUNT}}{{CHANNEL_LINKS}}</div><span>サーバー: {{SERVER_NAME}}</span><span>NICK: {{NICK}}</span></body></html>",
}));
vi.mock("../../src/templates/settings.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}{{ERROR}}この設定はチャンネル画面にのみ適用されます。{{PRESET_CONTROLS}}<form action=\"{{ACTION_URL}}\"><input name=\"fontFamily\" value=\"{{FONT_FAMILY}}\"><input name=\"fontSizePx\" value=\"{{FONT_SIZE_PX}}\">{{COLOR_FIELDS}}<input type=\"checkbox\" name=\"enableInlineUrlPreview\" {{ENABLE_INLINE_URL_PREVIEW_CHECKED}}><textarea name=\"highlightKeywords\">{{HIGHLIGHT_KEYWORDS}}</textarea><textarea name=\"dimKeywords\">{{DIM_KEYWORDS}}</textarea><textarea>{{EXTRA_CSS}}</textarea>{{DISPLAY_ORDER_ASC_CHECKED}}{{DISPLAY_ORDER_DESC_CHECKED}}</form>{{SETTINGS_SCRIPT}}</body></html>",
}));

import {
  buildAdminCss,
  buildChannelCss,
  buildChannelListPage,
  buildSettingsPage,
  buildWebUiSettings,
  createWebModule,
  type PersistedWebLogs,
} from "../../src/modules/web";

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
  beforeEach(() => {
    resolveMessageEmbedMock.mockReset();
    resolveMessageEmbedMock.mockResolvedValue(undefined);
  });

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

  it("buildChannelMessagesPage asc: messages stay chronological and only auto-scroll near bottom", async () => {
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
    expect(html).toContain("nearBottomThreshold = 48");
    expect(html).toContain("sessionStorage.getItem");
    expect(html).toContain("beforeunload");
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
    expect(html).not.toContain("nearBottomThreshold = 48");
    expect(html).not.toContain("sessionStorage.getItem");
  });

  it("buildChannelComposerPage includes the list link, reloads messages after submit, and blocks frame scrolling", () => {
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
    expect(html).toContain('target="_top"');
    expect(html).toContain("☰");
    expect(html).toContain('value="draft"');
    expect(html).toContain("送信失敗");
    expect(html).toContain("channel-messages-frame");
    expect(html).toContain("location.reload()");
    expect(html).toContain('window.addEventListener("wheel"');
    expect(html).toContain('window.addEventListener("touchmove"');
    expect(html).toContain("event.preventDefault()");
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
      keywordColor: "#FF4400",
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
    expect(css).toContain("--accent-keyword: #FF4400;");
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
      buildWebUiSettings({ displayOrder: "asc", extraCss: "body { color: blue; }", enableInlineUrlPreview: true }),
      "入力エラー"
    );

    expect(html).toContain("/proxy/main/web/settings");
    expect(html).toContain("body { color: blue; }");
    expect(html).toContain("この設定はチャンネル画面にのみ適用されます。");
    expect(html).toContain("入力エラー");
    expect(html).toContain('name="borderColor"');
    expect(html).toContain('name="mutedTextColor"');
    expect(html).toContain('name="keywordColor"');
    expect(html).toContain('name="highlightKeywords"');
    expect(html).toContain('name="dimKeywords"');
    expect(html).toContain('name="enableInlineUrlPreview"');
    expect(html).toContain("ライト");
    expect(html).toContain("ダーク");
    expect(html).toContain('"borderColor":"#0B5FFF"');
    expect(html).toContain("checked");
    expect(html).toContain("ADMIN_CSS");
  });

  it("renders inline URL embeds when the setting is enabled", async () => {
    resolveMessageEmbedMock.mockResolvedValue({
      kind: "image",
      sourceUrl: "https://cdn.example.com/cat.jpg",
      imageUrl: "https://cdn.example.com/cat.jpg",
    });
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "look https://cdn.example.com/cat.jpg"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ enableInlineUrlPreview: true })
    );

    expect(html).toContain("url-embed-container");
    expect(html).toContain('src="https://cdn.example.com/cat.jpg"');
    expect(html).not.toContain('id="url-preview-popup"');
  });

  it("renders hover and long-press preview hooks when inline preview is disabled", async () => {
    resolveMessageEmbedMock.mockResolvedValue({
      kind: "card",
      sourceUrl: "https://example.com/post",
      imageUrl: "https://example.com/card.jpg",
      title: "Example title",
      siteName: "Example",
    });
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "look https://example.com/post"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ enableInlineUrlPreview: false })
    );

    expect(html).toContain('data-preview-kind="card"');
    expect(html).toContain('data-preview-title="Example title"');
    expect(html).toContain('id="url-preview-popup"');
    expect(html).toContain("pointerdown");
    expect(html).not.toContain("url-embed-container");
  });

  it("renders text-only URL embeds for X previews", async () => {
    resolveMessageEmbedMock.mockResolvedValue({
      kind: "card",
      sourceUrl: "https://x.com/example/status/1",
      siteName: "X",
      title: "Xユーザーのexampleさん",
      description: "post body",
    });
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "look https://x.com/example/status/1"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ enableInlineUrlPreview: true })
    );

    expect(html).toContain("url-embed--text-only");
    expect(html).toContain("Xユーザーのexampleさん");
    expect(html).toContain("post body");
    expect(html).not.toContain('src="undefined"');
  });

  it("highlights registered keywords in message text with keyword-hl span", async () => {
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "hello world"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ highlightKeywords: "hello" })
    );

    expect(html).toContain('<span class="keyword-hl">hello</span>');
    expect(html).toContain("world");
  });

  it("keyword highlighting is case-insensitive and preserves original casing", async () => {
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "Hello World"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ highlightKeywords: "hello" })
    );

    expect(html).toContain('<span class="keyword-hl">Hello</span>');
  });

  it("keyword highlighting does not wrap text inside anchor tags", async () => {
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "visit https://example.com and say hello"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ highlightKeywords: "example" })
    );

    // URL anchor should be intact
    expect(html).toContain('<a href="https://example.com"');
    // "example" inside the <a> tag should NOT be wrapped
    expect(html).not.toMatch(/<a [^>]*>.*<span class="keyword-hl">example<\/span>/);
  });

  it("adds msg-dimmed class to lines containing a dim keyword", async () => {
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "bot!bot@host",
      command: "PRIVMSG",
      params: ["#general", "NickServ: Please identify"],
    });
    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "hello everyone"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ dimKeywords: "NickServ" })
    );

    expect(html).toContain('<div class="msg-dimmed">');
    // Normal message should not be dimmed
    const normalDivIdx = html.lastIndexOf("hello everyone");
    const dimmedDivIdx = html.indexOf('<div class="msg-dimmed">');
    expect(normalDivIdx).toBeGreaterThan(-1);
    expect(dimmedDivIdx).toBeGreaterThan(-1);
    // Only one line should be dimmed
    expect(html.split('<div class="msg-dimmed">').length - 1).toBe(1);
  });

  it("no msg-dimmed class when dim keywords list is empty", async () => {
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "hello"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ dimKeywords: "" })
    );

    expect(html).not.toContain("msg-dimmed");
  });
});
