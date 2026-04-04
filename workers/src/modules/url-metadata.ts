/**
 * URL metadata extraction utility.
 * Fetches page titles and preview images for URLs, similar to ircpost.cgi.
 */

const MAX_MESSAGE_LENGTH = 400;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 32 * 1024;
const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif"]);

export interface ResolvedUrlEmbed {
  kind: "image" | "card";
  sourceUrl: string;
  imageUrl: string;
  title?: string;
  siteName?: string;
}

interface OEmbedPayload {
  title?: string;
  provider_name?: string;
  thumbnail_url?: string;
  url?: string;
  type?: string;
}

interface HtmlMetadata {
  html: string;
  finalUrl: string;
}

/**
 * Extract metadata from a URL for posting to IRC.
 *
 * - X/Twitter: uses oEmbed API to get author + tweet text
 * - Other URLs: fetches HTML and extracts <title>
 * - Fallback: returns the URL as-is
 */
export async function extractUrlMetadata(url: string): Promise<string> {
  try {
    if (/^https?:\/\/(x|twitter)\.com\//i.test(url)) {
      return await extractTwitterMetadata(url);
    }
    return await extractPageTitle(url);
  } catch {
    return url;
  }
}

/**
 * Resolves the first embeddable URL contained in the message text.
 */
export async function resolveMessageEmbed(text: string): Promise<ResolvedUrlEmbed | undefined> {
  const urls = Array.from(text.matchAll(URL_RE), (match) => match[1]);
  for (const url of urls) {
    const embed = await resolveUrlEmbed(url);
    if (embed) {
      return embed;
    }
  }
  return undefined;
}

/**
 * Resolves a URL into a stored preview representation for the Web UI.
 */
export async function resolveUrlEmbed(url: string): Promise<ResolvedUrlEmbed | undefined> {
  try {
    const imageEmbed = resolveDirectImageEmbed(url);
    if (imageEmbed) {
      return imageEmbed;
    }

    const youtubeEmbed = await resolveYouTubeEmbed(url);
    if (youtubeEmbed) {
      return youtubeEmbed;
    }

    return await resolveHtmlEmbed(url);
  } catch {
    return undefined;
  }
}

async function extractTwitterMetadata(url: string): Promise<string> {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;

  const resp = await fetch(oembedUrl, {
    headers: { "User-Agent": "apricot-irc-proxy/0.1" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    // Fall back to generic title extraction
    return extractPageTitle(url);
  }

  const data = (await resp.json()) as {
    author_name?: string;
    html?: string;
  };

  const authorName = data.author_name || "";
  let text = "";

  if (data.html) {
    // Strip HTML tags
    text = data.html.replace(/<[^>]*>/g, "");
    // Remove everything after em-dash (twitter attribution)
    text = text.replace(/\u2014.*$/, "").trim();
    // Collapse whitespace
    text = text.replace(/\s+/g, " ").trim();
  }

  if (text) {
    const result = `Xユーザーの${authorName}さん: 「${text}」 / X ${url}`;
    return truncate(result);
  }

  return truncate(`${authorName} / X ${url}`);
}

async function extractPageTitle(url: string): Promise<string> {
  const metadata = await fetchHtmlMetadata(url);
  if (!metadata) {
    return url;
  }

  const title = extractTitleFromHtml(metadata.html);
  if (title) {
    return truncate(`${title} ${url}`);
  }

  return url;
}

function resolveDirectImageEmbed(url: string): ResolvedUrlEmbed | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const extension = parsed.pathname.split(".").pop()?.toLowerCase();
  if (!extension || !IMAGE_EXTENSIONS.has(extension)) {
    return undefined;
  }

  return {
    kind: "image",
    sourceUrl: url,
    imageUrl: url,
  };
}

async function resolveYouTubeEmbed(url: string): Promise<ResolvedUrlEmbed | undefined> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return undefined;
  }

  const maxResUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  const imageUrl = await canFetchImage(maxResUrl)
    ? maxResUrl
    : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;

  try {
    const resp = await fetch(oembedUrl, {
      headers: { "User-Agent": "apricot-irc-proxy/0.1" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (resp.ok) {
      const data = (await resp.json()) as OEmbedPayload;
      return {
        kind: "card",
        sourceUrl: url,
        imageUrl,
        title: cleanMetadataText(data.title),
        siteName: cleanMetadataText(data.provider_name) || "YouTube",
      };
    }
  } catch {
    // Fall through to title-less card.
  }

  return {
    kind: "card",
    sourceUrl: url,
    imageUrl,
    siteName: "YouTube",
  };
}

async function resolveHtmlEmbed(url: string): Promise<ResolvedUrlEmbed | undefined> {
  const metadata = await fetchHtmlMetadata(url);
  if (!metadata) {
    return undefined;
  }

  const imageUrl = extractPreviewImageUrl(metadata.html, metadata.finalUrl);
  const title = extractMetaContent(metadata.html, "property", "og:title")
    ?? extractMetaContent(metadata.html, "name", "twitter:title")
    ?? extractTitleFromHtml(metadata.html);
  const siteName = extractMetaContent(metadata.html, "property", "og:site_name");

  if (imageUrl) {
    return {
      kind: "card",
      sourceUrl: url,
      imageUrl,
      title: cleanMetadataText(title),
      siteName: cleanMetadataText(siteName),
    };
  }

  const oembedHref = extractOEmbedLinkHref(metadata.html, metadata.finalUrl);
  if (!oembedHref) {
    return undefined;
  }

  const oembed = await fetchOEmbed(oembedHref);
  if (!oembed) {
    return undefined;
  }

  const oembedImage = resolveOEmbedImage(oembed, metadata.finalUrl);
  if (!oembedImage) {
    return undefined;
  }

  return {
    kind: "card",
    sourceUrl: url,
    imageUrl: oembedImage,
    title: cleanMetadataText(oembed.title) ?? cleanMetadataText(title),
    siteName: cleanMetadataText(oembed.provider_name) ?? cleanMetadataText(siteName),
  };
}

async function fetchHtmlMetadata(url: string): Promise<HtmlMetadata | undefined> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "apricot-irc-proxy/0.1",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    return undefined;
  }

  const contentType = resp.headers.get("Content-Type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    return undefined;
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    return undefined;
  }

  let html = "";
  const decoder = new TextDecoder();

  try {
    let totalRead = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      totalRead += value.byteLength;
      if (totalRead >= MAX_HTML_BYTES) break;
      if (/<\/head>/i.test(html)) break;
    }
  } finally {
    await reader.cancel();
  }

  return {
    html,
    finalUrl: resp.url || url,
  };
}

function extractPreviewImageUrl(html: string, baseUrl: string): string | undefined {
  const ogImage = extractMetaContent(html, "property", "og:image");
  if (ogImage) {
    return resolveAgainstBaseUrl(ogImage, baseUrl);
  }

  const twitterImage = extractMetaContent(html, "name", "twitter:image");
  if (twitterImage) {
    return resolveAgainstBaseUrl(twitterImage, baseUrl);
  }

  return undefined;
}

function extractMetaContent(
  html: string,
  attrName: "property" | "name",
  attrValue: string,
): string | undefined {
  const metaTagRe = /<meta\b[^>]*>/gi;
  for (const tagMatch of html.matchAll(metaTagRe)) {
    const tag = tagMatch[0];
    const candidate = getHtmlAttribute(tag, attrName);
    if (!candidate || candidate.toLowerCase() !== attrValue.toLowerCase()) {
      continue;
    }
    const content = getHtmlAttribute(tag, "content");
    if (content) {
      return decodeHtmlEntities(content);
    }
  }
  return undefined;
}

function extractTitleFromHtml(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return undefined;
  }
  return cleanMetadataText(match[1]);
}

function extractOEmbedLinkHref(html: string, baseUrl: string): string | undefined {
  const linkTagRe = /<link\b[^>]*>/gi;
  for (const tagMatch of html.matchAll(linkTagRe)) {
    const tag = tagMatch[0];
    const type = getHtmlAttribute(tag, "type");
    if (!type || type.toLowerCase() !== "application/json+oembed") {
      continue;
    }
    const href = getHtmlAttribute(tag, "href");
    if (href) {
      return resolveAgainstBaseUrl(href, baseUrl);
    }
  }
  return undefined;
}

async function fetchOEmbed(url: string): Promise<OEmbedPayload | undefined> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "apricot-irc-proxy/0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return undefined;
    }
    return await resp.json() as OEmbedPayload;
  } catch {
    return undefined;
  }
}

function resolveOEmbedImage(payload: OEmbedPayload, baseUrl: string): string | undefined {
  if (payload.thumbnail_url) {
    return resolveAgainstBaseUrl(payload.thumbnail_url, baseUrl);
  }
  if (payload.type === "photo" && payload.url) {
    return resolveAgainstBaseUrl(payload.url, baseUrl);
  }
  return undefined;
}

function resolveAgainstBaseUrl(candidate: string, baseUrl: string): string | undefined {
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function getHtmlAttribute(tag: string, attrName: string): string | undefined {
  const escapedName = attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quotedRe = new RegExp(`${escapedName}\\s*=\\s*([\"'])(.*?)\\1`, "i");
  const quoted = tag.match(quotedRe);
  if (quoted) {
    return decodeHtmlEntities(quoted[2]);
  }

  const bareRe = new RegExp(`${escapedName}\\s*=\\s*([^\\s>]+)`, "i");
  const bare = tag.match(bareRe);
  if (bare) {
    return decodeHtmlEntities(bare[1]);
  }

  return undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function cleanMetadataText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = decodeHtmlEntities(value)
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || undefined;
}

function extractYouTubeVideoId(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "youtu.be") {
    return parsed.pathname.split("/").filter(Boolean)[0];
  }

  if (hostname === "www.youtube.com" || hostname === "youtube.com" || hostname === "m.youtube.com") {
    if (parsed.pathname === "/watch") {
      return parsed.searchParams.get("v") ?? undefined;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "shorts" || segments[0] === "live" || segments[0] === "embed") {
      return segments[1];
    }
  }

  return undefined;
}

async function canFetchImage(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "apricot-irc-proxy/0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    const contentType = resp.headers.get("Content-Type") || "";
    return resp.ok && contentType.startsWith("image/");
  } catch {
    return false;
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.substring(0, MAX_MESSAGE_LENGTH - 3) + "...";
}
