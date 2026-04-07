import Encoding from "encoding-japanese";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractUrlMetadata,
  isAllowedPreviewUrl,
  resolveMessageEmbed,
  resolveUrlEmbed,
} from "../../src/modules/url-metadata";

function encodeShiftJisHtml(html: string): Uint8Array {
  return new Uint8Array(
    Encoding.convert(Encoding.stringToCode(html), { to: "SJIS", from: "UNICODE", type: "array" }),
  );
}

function createHtmlResponse(html: string, contentType: string): Response {
  return new Response(encodeShiftJisHtml(html), {
    headers: { "Content-Type": contentType },
  });
}

describe("url metadata resolver", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns inline image embeds for direct image URLs without fetching HTML", async () => {
    const embed = await resolveUrlEmbed("https://cdn.example.com/cat.jpg");

    expect(embed).toEqual({
      kind: "image",
      sourceUrl: "https://cdn.example.com/cat.jpg",
      imageUrl: "https://cdn.example.com/cat.jpg",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes X oEmbed text before returning metadata", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://publish.x.com/oembed")) {
        return Response.json({
          author_name: "We don&#39;t deserve cats 😺",
          html: "<blockquote><p>She adores her only baby.. pic.twitter.com/PlPzyKtKBc&mdash; We don&#39;t deserve cats 😺 (@catsareblessing) April 4, 2026</p></blockquote>",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const metadata = await extractUrlMetadata("https://x.com/catsareblessing/status/2040275667414053299");

    expect(metadata).toContain("XユーザーのWe don't deserve cats 😺さん");
    expect(metadata).toContain("She adores her only baby.. pic.twitter.com/PlPzyKtKBc");
    expect(metadata).not.toContain("&amp;#39;");
    expect(metadata).not.toContain("&amp;mdash;");
    expect(metadata).not.toContain("(@catsareblessing)");
  });

  it("prefers Browser Rendering titles when credentials are configured", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/scrape") {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
        expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
        expect(JSON.parse(String(init?.body))).toEqual({
          url: "https://example.com/dynamic",
          elements: [{ selector: "title" }],
          gotoOptions: { waitUntil: "networkidle0" },
        });
        return Response.json({
          success: true,
          result: [
            {
              selector: "title",
              results: [{ text: "Rendered Title" }],
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const metadata = await extractUrlMetadata("https://example.com/dynamic", {
      browserRendering: {
        accountId: "test-account",
        apiToken: "test-token",
      },
    });

    expect(metadata).toBe("Rendered Title https://example.com/dynamic");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to static HTML titles when Browser Rendering returns no title", async () => {
    const calledUrls: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      calledUrls.push(url);
      if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/scrape") {
        return Response.json({
          success: true,
          result: [
            {
              selector: "title",
              results: [],
            },
          ],
        });
      }
      if (url === "https://example.com/fallback") {
        return new Response("<html><head><title>Static Title</title></head></html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const metadata = await extractUrlMetadata("https://example.com/fallback", {
      browserRendering: {
        accountId: "test-account",
        apiToken: "test-token",
      },
    });

    expect(metadata).toBe("Static Title https://example.com/fallback");
    expect(calledUrls).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/scrape",
      "https://example.com/fallback",
    ]);
  });

  it("falls back to static HTML titles when Browser Rendering fails", async () => {
    const calledUrls: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      calledUrls.push(url);
      if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/scrape") {
        return new Response("error", { status: 500 });
      }
      if (url === "https://example.com/error-fallback") {
        return new Response("<html><head><title>Recovered Title</title></head></html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const metadata = await extractUrlMetadata("https://example.com/error-fallback", {
      browserRendering: {
        accountId: "test-account",
        apiToken: "test-token",
      },
    });

    expect(metadata).toBe("Recovered Title https://example.com/error-fallback");
    expect(calledUrls).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/scrape",
      "https://example.com/error-fallback",
    ]);
  });

  it("resolves X URLs as rich embeds and includes the configured theme", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://publish.x.com/oembed")) {
        expect(url).toContain("omit_script=1");
        expect(url).toContain("maxwidth=355");
        expect(url).toContain("maxheight=200");
        expect(url).toContain("theme=dark");
        return Response.json({
          author_name: "We don&#39;t deserve cats 😺",
          html: "<blockquote class=\"twitter-tweet\"><p>She adores her only baby.. pic.twitter.com/PlPzyKtKBc&mdash; We don&#39;t deserve cats 😺 (@catsareblessing) April 4, 2026</p></blockquote>",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const embed = await resolveUrlEmbed("https://x.com/catsareblessing/status/2040275667414053299", {
      xTheme: "dark",
    });

    expect(embed).toEqual({
      kind: "rich",
      sourceUrl: "https://x.com/catsareblessing/status/2040275667414053299",
      siteName: "X",
      title: "XユーザーのWe don't deserve cats 😺さん",
      description: "She adores her only baby.. pic.twitter.com/PlPzyKtKBc",
      html: "<blockquote class=\"twitter-tweet\"><p>She adores her only baby.. pic.twitter.com/PlPzyKtKBc&mdash; We don&#39;t deserve cats 😺 (@catsareblessing) April 4, 2026</p></blockquote>",
    });
  });

  it("falls back to a text card for X URLs when oEmbed html is empty", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://publish.x.com/oembed")) {
        expect(url).toContain("theme=light");
        return Response.json({
          author_name: "We don&#39;t deserve cats 😺",
          html: "",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const embed = await resolveUrlEmbed("https://x.com/catsareblessing/status/2040275667414053299");

    expect(embed).toEqual({
      kind: "card",
      sourceUrl: "https://x.com/catsareblessing/status/2040275667414053299",
      siteName: "X",
      title: "XユーザーのWe don't deserve cats 😺さん",
      description: undefined,
    });
  });

  it("resolves the first embeddable URL from a message", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://example.com/article") {
        return new Response("<html><head><meta property=\"og:image\" content=\"/card.jpg\"></head></html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    const embed = await resolveMessageEmbed("first https://example.invalid/nope then https://example.com/article");

    expect(embed).toMatchObject({
      kind: "card",
      sourceUrl: "https://example.com/article",
      imageUrl: "https://example.com/card.jpg",
    });
  });

  it("resolves YouTube watch URLs as rich embeds with oEmbed metadata", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://www.youtube.com/oembed")) {
        expect(init?.method).toBeUndefined();
        return Response.json({
          title: "Sample Video",
          provider_name: "YouTube",
        });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    const embed = await resolveUrlEmbed("https://www.youtube.com/watch?v=abc123xyz00");

    expect(embed).toEqual({
      kind: "rich",
      sourceUrl: "https://www.youtube.com/watch?v=abc123xyz00",
      title: "Sample Video",
      siteName: "YouTube",
      html: "<iframe width=\"355\" height=\"200\" src=\"https://www.youtube.com/embed/abc123xyz00\" title=\"YouTube video player\" frameborder=\"0\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share\" referrerpolicy=\"strict-origin-when-cross-origin\" allowfullscreen></iframe>",
    });
  });

  it("resolves YouTube shorts URLs as rich embeds with tall iframes", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://www.youtube.com/oembed")) {
        return Response.json({
          title: "Sample Short",
          provider_name: "YouTube",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const embed = await resolveUrlEmbed("https://www.youtube.com/shorts/MzL20PlmzpA");

    expect(embed).toEqual({
      kind: "rich",
      sourceUrl: "https://www.youtube.com/shorts/MzL20PlmzpA",
      title: "Sample Short",
      siteName: "YouTube",
      html: "<iframe width=\"355\" height=\"631\" src=\"https://www.youtube.com/embed/MzL20PlmzpA\" title=\"YouTube video player\" frameborder=\"0\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share\" referrerpolicy=\"strict-origin-when-cross-origin\" allowfullscreen></iframe>",
    });
  });

  it("falls back to title-less rich embeds when YouTube oEmbed fails", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://www.youtube.com/oembed")) {
        throw new Error("oEmbed unavailable");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const embed = await resolveUrlEmbed("https://www.youtube.com/watch?v=abc123xyz00");

    expect(embed).toEqual({
      kind: "rich",
      sourceUrl: "https://www.youtube.com/watch?v=abc123xyz00",
      siteName: "YouTube",
      html: "<iframe width=\"355\" height=\"200\" src=\"https://www.youtube.com/embed/abc123xyz00\" title=\"YouTube video player\" frameborder=\"0\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share\" referrerpolicy=\"strict-origin-when-cross-origin\" allowfullscreen></iframe>",
    });
  });

  it("prefers og:image metadata for generic HTML pages", async () => {
    fetchMock.mockResolvedValue(new Response(
      "<html><head><meta property=\"og:image\" content=\"/images/card.jpg\"><meta property=\"og:title\" content=\"OG Title\"><meta property=\"og:site_name\" content=\"OG Site\"></head></html>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    ));

    const embed = await resolveUrlEmbed("https://example.com/posts/1");

    expect(embed).toEqual({
      kind: "card",
      sourceUrl: "https://example.com/posts/1",
      imageUrl: "https://example.com/images/card.jpg",
      title: "OG Title",
      siteName: "OG Site",
      description: undefined,
    });
  });

  it("decodes Shift_JIS HTML from the Content-Type header before building cards", async () => {
    fetchMock.mockResolvedValue(createHtmlResponse(
      "<html><head><meta property=\"og:image\" content=\"/images/oricon.jpg\"><meta property=\"og:title\" content=\"粗品、入学式にサプライズで登場\"><meta property=\"og:description\" content=\"会場どよめき 2300人に魂のメッセージ\"><meta property=\"og:site_name\" content=\"ORICON NEWS\"></head></html>",
      "text/html; charset=Shift_JIS",
    ));

    const embed = await resolveUrlEmbed("https://example.com/oricon");

    expect(embed).toEqual({
      kind: "card",
      sourceUrl: "https://example.com/oricon",
      imageUrl: "https://example.com/images/oricon.jpg",
      title: "粗品、入学式にサプライズで登場",
      siteName: "ORICON NEWS",
      description: "会場どよめき 2300人に魂のメッセージ",
    });
  });

  it("decodes Shift_JIS HTML from a meta charset declaration when the header omits charset", async () => {
    fetchMock.mockResolvedValue(createHtmlResponse(
      "<html><head><meta charset=\"Shift_JIS\"><meta property=\"og:image\" content=\"/images/meta-only.jpg\"><meta property=\"og:title\" content=\"メタ指定だけでも読める\"></head></html>",
      "text/html",
    ));

    const embed = await resolveUrlEmbed("https://example.com/meta-only");

    expect(embed).toEqual({
      kind: "card",
      sourceUrl: "https://example.com/meta-only",
      imageUrl: "https://example.com/images/meta-only.jpg",
      title: "メタ指定だけでも読める",
      siteName: undefined,
      description: undefined,
    });
  });

  it("detects Shift_JIS HTML when neither header nor meta declares a charset", async () => {
    fetchMock.mockResolvedValue(createHtmlResponse(
      "<html><head><title>文字コード自動判定で取得</title></head></html>",
      "text/html",
    ));

    const metadata = await extractUrlMetadata("https://example.com/detect-only");

    expect(metadata).toBe("文字コード自動判定で取得 https://example.com/detect-only");
  });

  it("uses twitter:image when og:image is missing", async () => {
    fetchMock.mockResolvedValue(new Response(
      "<html><head><meta name=\"twitter:image\" content=\"https://cdn.example.com/twitter.jpg\"><meta name=\"twitter:title\" content=\"Twitter Title\"></head></html>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    ));

    const embed = await resolveUrlEmbed("https://example.com/posts/2");

    expect(embed).toEqual({
      kind: "card",
      sourceUrl: "https://example.com/posts/2",
      imageUrl: "https://cdn.example.com/twitter.jpg",
      title: "Twitter Title",
      siteName: undefined,
      description: undefined,
    });
  });

  it("falls back to oEmbed discovery when page metadata has no preview image", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://example.com/posts/3") {
        return new Response(
          "<html><head><link rel=\"alternate\" type=\"application/json+oembed\" href=\"https://api.example.com/oembed?url=3\"><title>Page Title</title></head></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      if (url === "https://api.example.com/oembed?url=3") {
        return Response.json({
          title: "Embed Title",
          provider_name: "Example Provider",
          thumbnail_url: "https://cdn.example.com/thumb.jpg",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const embed = await resolveUrlEmbed("https://example.com/posts/3");

    expect(embed).toEqual({
      kind: "card",
      sourceUrl: "https://example.com/posts/3",
      imageUrl: "https://cdn.example.com/thumb.jpg",
      title: "Embed Title",
      siteName: "Example Provider",
      description: undefined,
    });
  });

  it("returns undefined when a page does not expose any preview image", async () => {
    fetchMock.mockResolvedValue(new Response(
      "<html><head><title>No Preview</title></head></html>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    ));

    await expect(resolveUrlEmbed("https://example.com/no-preview")).resolves.toBeUndefined();
  });

  it("rejects localhost and private-network preview URLs", async () => {
    expect(isAllowedPreviewUrl("http://localhost/test")).toBe(false);
    expect(isAllowedPreviewUrl("http://127.0.0.1/test")).toBe(false);
    expect(isAllowedPreviewUrl("http://169.254.1.1/test")).toBe(false);
    expect(isAllowedPreviewUrl("http://10.0.0.1/test")).toBe(false);
    expect(isAllowedPreviewUrl("http://[::1]/test")).toBe(false);
    expect(isAllowedPreviewUrl("http://[fe80::1]/test")).toBe(false);
    expect(isAllowedPreviewUrl("http://[fd00::1]/test")).toBe(false);
    expect(isAllowedPreviewUrl("http://example.com:8080/test")).toBe(false);
  });

  it("allows public IPv6 preview URLs", () => {
    expect(isAllowedPreviewUrl("https://[2001:4860:4860::8888]/test")).toBe(true);
  });

  it("uses static HTML titles when Browser Rendering credentials are not configured", async () => {
    fetchMock.mockResolvedValue(new Response(
      "<html><head><title>Static Only Title</title></head></html>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    ));

    const metadata = await extractUrlMetadata("https://example.com/static-only");

    expect(metadata).toBe("Static Only Title https://example.com/static-only");
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/static-only", expect.any(Object));
  });

  it("does not call Browser Rendering for X URLs even when credentials are configured", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      expect(url).not.toContain("/browser-rendering/scrape");
      if (url.startsWith("https://publish.x.com/oembed")) {
        return Response.json({
          author_name: "Example",
          html: "<blockquote><p>Hello world&mdash; Example (@example) April 4, 2026</p></blockquote>",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const metadata = await extractUrlMetadata("https://x.com/example/status/1", {
      browserRendering: {
        accountId: "test-account",
        apiToken: "test-token",
      },
    });

    expect(metadata).toContain("XユーザーのExampleさん");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch Browser Rendering or HTML for blocked URLs", async () => {
    const metadata = await extractUrlMetadata("http://localhost/test", {
      browserRendering: {
        accountId: "test-account",
        apiToken: "test-token",
      },
    });

    expect(metadata).toBe("http://localhost/test");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch blocked preview URLs from message text", async () => {
    const embed = await resolveMessageEmbed("first http://localhost/test then http://10.0.0.1/x");

    expect(embed).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
