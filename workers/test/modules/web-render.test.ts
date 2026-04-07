import { describe, expect, it } from "vitest";
import "./web-test-helpers";
import {
  buildChannelComposerPage,
  buildChannelListPage,
  buildChannelMessagesFragment,
  buildChannelMessagesPage,
  buildChannelPage,
  buildSettingsPage,
} from "../../src/modules/web-render";
import { buildWebUiSettings } from "../../src/modules/web-theme";
import type { StoredMessage } from "../../src/modules/web-types";

function makeMessages(messages: Array<Partial<StoredMessage> & Pick<StoredMessage, "type" | "nick" | "text">>): StoredMessage[] {
  return messages.map((message, index) => ({
    sequence: index + 1,
    time: (index + 1) * 1000,
    ...message,
  }));
}

describe("web-render", () => {
  it("builds channel pages in display order aware layout", () => {
    const descHtml = buildChannelPage(
      "#general",
      "",
      "/proxy/main/web",
      buildWebUiSettings({ displayOrder: "desc" }),
    );
    const ascHtml = buildChannelPage(
      "#general",
      "",
      "/proxy/main/web",
      buildWebUiSettings({ displayOrder: "asc" }),
    );

    expect(descHtml.indexOf("channel-composer-frame")).toBeLessThan(descHtml.indexOf("channel-messages-frame"));
    expect(descHtml).not.toContain("stickToLatestMessage");
    expect(ascHtml.indexOf("channel-messages-frame")).toBeLessThan(ascHtml.indexOf("channel-composer-frame"));
    expect(ascHtml).toContain("stickToLatestMessage");
  });

  it("renders messages page and fragment metadata in both display modes", () => {
    const messages = makeMessages([
      { type: "privmsg", nick: "alice", text: "first" },
      { type: "privmsg", nick: "alice", text: "second" },
    ]);
    const ascHtml = buildChannelMessagesPage(
      "#general",
      "",
      messages,
      "apricot",
      0,
      buildWebUiSettings({ displayOrder: "asc" }),
      2,
    );
    const descHtml = buildChannelMessagesPage(
      "#general",
      "",
      messages,
      "apricot",
      0,
      buildWebUiSettings({ displayOrder: "desc" }),
      2,
    );
    const fragment = buildChannelMessagesFragment(
      "#general",
      messages,
      "apricot",
      0,
      buildWebUiSettings(),
      1,
    );

    expect(ascHtml.indexOf("first")).toBeLessThan(ascHtml.indexOf("second"));
    expect(ascHtml).toContain("nearBottomThreshold = 48");
    expect(ascHtml).toContain("var apricotLatestSequence = 2");
    const shellStart = descHtml.indexOf('<div id="channel-messages-shell">');
    const shellEnd = descHtml.indexOf("</div><button", shellStart);
    const messagesMarkup = descHtml.slice(shellStart, shellEnd);
    expect(messagesMarkup.indexOf("second")).toBeLessThan(messagesMarkup.indexOf("first"));
    expect(descHtml).toContain("再読込");
    expect(fragment.mode).toBe("delta");
    expect(fragment.startSequence).toBe(1);
    expect(fragment.latestSequence).toBe(2);
    expect(fragment.html).toContain("second");
  });

  it("renders composer page with list link and refresh hook", () => {
    const html = buildChannelComposerPage(
      "#general",
      "/proxy/main/web",
      "draft",
      "送信失敗",
      "danger",
      buildWebUiSettings(),
      true,
    );

    expect(html).toContain('action="/proxy/main/web/%23general/composer"');
    expect(html).toContain('href="/proxy/main/web/"');
    expect(html).toContain('target="_top"');
    expect(html).toContain('value="draft"');
    expect(html).toContain("refreshMessages");
    expect(html).toContain("location.reload()");
  });

  it("renders channel list page placeholders and persisted config values", () => {
    const html = buildChannelListPage(
      ["#general"],
      "apricot",
      "irc.example.com",
      true,
      "/proxy/main/web",
      false,
      false,
      "保存しました",
      "info",
      { nick: "savednick", autojoin: "#general\n#random" },
    );

    expect(html).toContain("irc.example.com に apricot として参加");
    expect(html).toContain("サーバー: irc.example.com");
    expect(html).toContain("NICK: apricot");
    expect(html).toContain('action="/proxy/main/web/config"');
    expect(html).toContain('name="nick" value="savednick"');
    expect(html).toContain("#general\n#random");
  });

  it("renders settings page with preview, presets, and current values", () => {
    const html = buildSettingsPage(
      "apricot",
      "irc.example.com",
      "/proxy/main/web",
      buildWebUiSettings({ displayOrder: "asc", extraCss: "body { color: blue; }", enableInlineUrlPreview: true }),
      "入力エラー",
    );

    expect(html).toContain("/proxy/main/web/settings");
    expect(html).toContain("body { color: blue; }");
    expect(html).toContain("入力エラー");
    expect(html).toContain('data-theme-preview-root');
    expect(html).toContain('data-theme-preview-frame');
    expect(html).toContain('name="borderColor"');
    expect(html).toContain('name="keywordColor"');
    expect(html).toContain('name="enableInlineUrlPreview"');
    expect(html).toContain("Light");
    expect(html).toContain("Dark");
    expect(html).toContain("scheduleThemePreviewUpdate");
    expect(html.match(/updateThemePreview\(\);/g)?.length ?? 0).toBe(1);
  });

  it("renders inline and popup URL previews from stored embeds", () => {
    const richEmbed = {
      kind: "rich" as const,
      sourceUrl: "https://x.com/example/status/1",
      siteName: "X",
      title: "Xユーザーのexampleさん",
      description: "post body",
      html: "<blockquote class=\"twitter-tweet\"><p>post body</p></blockquote>",
    };
    const imageEmbed = {
      kind: "image" as const,
      sourceUrl: "https://cdn.example.com/cat.jpg",
      imageUrl: "https://cdn.example.com/cat.jpg",
    };
    const messages = makeMessages([
      { type: "privmsg", nick: "alice", text: "look https://x.com/example/status/1", embed: richEmbed },
      { type: "privmsg", nick: "alice", text: "look https://cdn.example.com/cat.jpg", embed: imageEmbed },
    ]);

    const inlineHtml = buildChannelMessagesPage(
      "#general",
      "",
      messages,
      "apricot",
      0,
      buildWebUiSettings({ enableInlineUrlPreview: true }),
      2,
    );
    const popupHtml = buildChannelMessagesPage(
      "#general",
      "",
      messages,
      "apricot",
      0,
      buildWebUiSettings({ enableInlineUrlPreview: false }),
      2,
    );

    expect(inlineHtml).toContain("url-embed-container");
    expect(inlineHtml).toContain("data-apricot-rich-embed");
    expect(inlineHtml).toContain("platform.twitter.com/widgets.js");
    expect(inlineHtml).toContain('src="https://cdn.example.com/cat.jpg"');
    expect(inlineHtml).not.toContain('id="url-preview-popup"');
    expect(popupHtml).toContain('id="url-preview-popup"');
    expect(popupHtml).toContain('data-preview-kind="rich"');
    expect(popupHtml).toContain('data-preview-template-id="url-preview-template-');
  });

  it("highlights and dims messages based on keyword settings", () => {
    const messages = makeMessages([
      { type: "notice", nick: "server", text: "NickServ: Please identify" },
      { type: "privmsg", nick: "alice", text: "visit https://example.com and say Hello" },
    ]);
    const html = buildChannelMessagesPage(
      "#general",
      "",
      messages,
      "apricot",
      0,
      buildWebUiSettings({
        highlightKeywords: "hello,example",
        dimKeywords: "NickServ",
      }),
      2,
    );

    expect(html).toContain('class="msg-dimmed"');
    expect(html).toContain('<span class="keyword-hl">Hello</span>');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).not.toMatch(/<a [^>]*>.*<span class="keyword-hl">example<\/span>/);
  });
});
