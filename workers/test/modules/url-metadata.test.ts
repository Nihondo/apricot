import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractUrlMetadata,
  isAllowedPreviewUrl,
  resolveMessageEmbed,
  resolveUrlEmbed,
} from "../../src/modules/url-metadata";

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

  it("resolves X URLs as text cards when oEmbed returns post text", async () => {
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

    const embed = await resolveUrlEmbed("https://x.com/catsareblessing/status/2040275667414053299");

    expect(embed).toEqual({
      kind: "card",
      sourceUrl: "https://x.com/catsareblessing/status/2040275667414053299",
      siteName: "X",
      title: "XユーザーのWe don't deserve cats 😺さん",
      description: "She adores her only baby.. pic.twitter.com/PlPzyKtKBc",
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

  it("resolves YouTube previews and falls back to hq thumbnails when maxres is unavailable", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("maxresdefault.jpg") && init?.method === "HEAD") {
        return new Response(null, { status: 404 });
      }
      if (url.startsWith("https://www.youtube.com/oembed")) {
        return Response.json({
          title: "Sample Video",
          provider_name: "YouTube",
        });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });

    const embed = await resolveUrlEmbed("https://www.youtube.com/watch?v=abc123xyz00");

    expect(embed).toEqual({
      kind: "card",
      sourceUrl: "https://www.youtube.com/watch?v=abc123xyz00",
      imageUrl: "https://img.youtube.com/vi/abc123xyz00/hqdefault.jpg",
      title: "Sample Video",
      siteName: "YouTube",
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
    expect(isAllowedPreviewUrl("http://example.com:8080/test")).toBe(false);
  });

  it("does not fetch blocked preview URLs from message text", async () => {
    const embed = await resolveMessageEmbed("first http://localhost/test then http://10.0.0.1/x");

    expect(embed).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
