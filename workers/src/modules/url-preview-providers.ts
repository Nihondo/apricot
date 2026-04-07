/**
 * URL プレビューの取得処理と provider 別解決ロジック。
 */

import Encoding from "encoding-japanese";
import {
  FETCH_TIMEOUT_MS,
  IMAGE_EXTENSIONS,
  MAX_HTML_BYTES,
  MAX_MESSAGE_LENGTH,
  X_OEMBED_ENDPOINTS,
  X_URL_RE,
  isAllowedPreviewUrl,
} from "./url-preview-policy";
import type {
  BrowserRenderingConfig,
  BrowserRenderingScrapeResponse,
  HtmlMetadata,
  OEmbedPayload,
  ResolvedUrlEmbed,
  XEmbedTheme,
  YouTubeEmbedInfo,
} from "./url-preview-types";

type HtmlEncodingTarget = "utf-8" | "SJIS" | "EUCJP" | "JIS";

/**
 * X の URL から投稿メタデータを抽出する。
 */
export async function extractTwitterMetadata(url: string): Promise<string> {
  const data = await fetchXOEmbedPayload(url, "light");
  if (!data) {
    return extractPageTitle(url);
  }

  const authorName = cleanMetadataText(data.author_name) || "";
  const text = normalizeTwitterOEmbedText(data.html);
  if (text) {
    return truncate(`Xユーザーの${authorName}さん: 「${text}」 / X ${url}`);
  }
  return truncate(`${authorName} / X ${url}`);
}

/**
 * Browser Rendering を優先しつつページタイトルを抽出する。
 */
export async function extractPageTitle(
  url: string,
  browserRendering?: BrowserRenderingConfig,
): Promise<string> {
  const renderedTitle = await extractRenderedPageTitle(url, browserRendering);
  if (renderedTitle) {
    return truncate(`${renderedTitle} ${url}`);
  }

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

/**
 * 直リンク画像・YouTube・X・一般 HTML の順で埋め込みを解決する。
 */
export async function resolveDirectOrRichEmbed(
  url: string,
  theme: XEmbedTheme,
): Promise<ResolvedUrlEmbed | undefined> {
  const imageEmbed = resolveDirectImageEmbed(url);
  if (imageEmbed) {
    return imageEmbed;
  }

  const youtubeEmbed = await resolveYouTubeEmbed(url);
  if (youtubeEmbed) {
    return youtubeEmbed;
  }

  const xEmbed = await resolveXEmbed(url, theme);
  if (xEmbed) {
    return xEmbed;
  }

  return resolveHtmlEmbed(url);
}

async function extractRenderedPageTitle(
  url: string,
  browserRendering?: BrowserRenderingConfig,
): Promise<string | undefined> {
  const accountId = browserRendering?.accountId.trim();
  const apiToken = browserRendering?.apiToken.trim();
  if (!accountId || !apiToken) {
    return undefined;
  }

  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/scrape`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        elements: [{ selector: "title" }],
        gotoOptions: { waitUntil: "networkidle0" },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = await response.json() as BrowserRenderingScrapeResponse;
    return cleanMetadataText(payload.result?.[0]?.results?.[0]?.text);
  } catch {
    return undefined;
  }
}

function resolveDirectImageEmbed(url: string): ResolvedUrlEmbed | undefined {
  if (!isAllowedPreviewUrl(url)) {
    return undefined;
  }

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

async function resolveXEmbed(url: string, theme: XEmbedTheme): Promise<ResolvedUrlEmbed | undefined> {
  if (!X_URL_RE.test(url)) {
    return undefined;
  }

  const data = await fetchXOEmbedPayload(url, theme);
  if (!data) {
    return undefined;
  }

  const authorName = cleanMetadataText(data.author_name);
  const description = normalizeTwitterOEmbedText(data.html) || undefined;
  const richHtml = cleanXRichEmbedHtml(data.html);
  const title = authorName ? `Xユーザーの${authorName}さん` : "Xの投稿";

  if (richHtml) {
    return {
      kind: "rich",
      sourceUrl: url,
      siteName: "X",
      title,
      description,
      html: richHtml,
    };
  }

  if (!authorName && !description) {
    return undefined;
  }

  return {
    kind: "card",
    sourceUrl: url,
    siteName: "X",
    title,
    description,
  };
}

async function resolveYouTubeEmbed(url: string): Promise<ResolvedUrlEmbed | undefined> {
  const embedInfo = extractYouTubeEmbedInfo(url);
  if (!embedInfo) {
    return undefined;
  }

  const html = buildYouTubeEmbedHtml(embedInfo);
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;

  try {
    const resp = await fetch(oembedUrl, {
      headers: { "User-Agent": "apricot-irc-proxy/0.1" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (resp.ok) {
      const data = await resp.json() as OEmbedPayload;
      return {
        kind: "rich",
        sourceUrl: url,
        title: cleanMetadataText(data.title),
        html,
        siteName: cleanMetadataText(data.provider_name) || "YouTube",
      };
    }
  } catch {
    // タイトルなしの埋め込みへフォールバックする。
  }

  return {
    kind: "rich",
    sourceUrl: url,
    html,
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
  const description = extractMetaContent(metadata.html, "property", "og:description")
    ?? extractMetaContent(metadata.html, "name", "twitter:description");
  const siteName = extractMetaContent(metadata.html, "property", "og:site_name");

  if (imageUrl) {
    return {
      kind: "card",
      sourceUrl: url,
      imageUrl,
      title: cleanMetadataText(title),
      siteName: cleanMetadataText(siteName),
      description: cleanMetadataText(description),
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
    description: cleanMetadataText(description),
  };
}

async function fetchXOEmbedPayload(url: string, theme: XEmbedTheme): Promise<OEmbedPayload | undefined> {
  for (const endpoint of X_OEMBED_ENDPOINTS) {
    const oembedUrl = `${endpoint}?url=${encodeURIComponent(url)}&omit_script=1&maxwidth=355&maxheight=200&theme=${theme}`;
    try {
      const resp = await fetch(oembedUrl, {
        headers: { "User-Agent": "apricot-irc-proxy/0.1" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        continue;
      }
      return await resp.json() as OEmbedPayload;
    } catch {
      // 次の endpoint を試す。
    }
  }
  return undefined;
}

async function fetchHtmlMetadata(url: string): Promise<HtmlMetadata | undefined> {
  if (!isAllowedPreviewUrl(url)) {
    return undefined;
  }

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

  const finalUrl = resp.url || url;
  if (!isAllowedPreviewUrl(finalUrl)) {
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

  let asciiHtml = "";
  const chunks: Uint8Array[] = [];

  try {
    let totalRead = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      totalRead += value.byteLength;
      asciiHtml += decodeAsciiChunk(value);
      if (totalRead >= MAX_HTML_BYTES || /<\/head>/i.test(asciiHtml)) {
        break;
      }
    }
  } finally {
    await reader.cancel();
  }

  const htmlBytes = concatBytes(chunks);
  const charset = resolveHtmlCharset(contentType, asciiHtml, htmlBytes);
  const html = decodeHtmlBytes(htmlBytes, charset);
  return { html, finalUrl };
}

function decodeAsciiChunk(value: Uint8Array): string {
  let ascii = "";
  for (const byte of value) {
    ascii += byte <= 0x7f ? String.fromCharCode(byte) : " ";
  }
  return ascii;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resolveHtmlCharset(
  contentType: string,
  asciiHtml: string,
  htmlBytes: Uint8Array,
): HtmlEncodingTarget {
  const headerCharset = normalizeHtmlCharset(extractCharsetFromContentType(contentType));
  if (headerCharset) {
    return headerCharset;
  }

  const metaCharset = normalizeHtmlCharset(extractCharsetFromHtml(asciiHtml));
  if (metaCharset) {
    return metaCharset;
  }

  const detectedCharset = Encoding.detect(htmlBytes, ["UTF8", "SJIS", "EUCJP", "JIS"]);
  return detectedCharset ? normalizeDetectedHtmlCharset(detectedCharset) : "utf-8";
}

function extractCharsetFromContentType(contentType: string): string | undefined {
  const match = contentType.match(/charset\s*=\s*("?)([^";,\s]+)\1/i);
  return match?.[2];
}

function extractCharsetFromHtml(asciiHtml: string): string | undefined {
  const metaCharsetMatch = asciiHtml.match(/<meta\b[^>]*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'/>]+))/i);
  if (metaCharsetMatch) {
    return metaCharsetMatch[1] || metaCharsetMatch[2] || metaCharsetMatch[3];
  }

  const httpEquivMatch = asciiHtml.match(
    /<meta\b[^>]*http-equiv\s*=\s*(?:"content-type"|'content-type'|content-type)[^>]*content\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'/>]+))/i,
  );
  if (!httpEquivMatch) {
    return undefined;
  }

  return extractCharsetFromContentType(httpEquivMatch[1] || httpEquivMatch[2] || httpEquivMatch[3] || "");
}

function normalizeHtmlCharset(charset?: string): HtmlEncodingTarget | undefined {
  if (!charset) {
    return undefined;
  }

  const normalizedCharset = charset.trim().toLowerCase();
  if (normalizedCharset === "utf-8" || normalizedCharset === "utf8") {
    return "utf-8";
  }
  if (
    normalizedCharset === "shift_jis"
    || normalizedCharset === "shift-jis"
    || normalizedCharset === "sjis"
    || normalizedCharset === "ms_kanji"
    || normalizedCharset === "cp932"
    || normalizedCharset === "windows-31j"
  ) {
    return "SJIS";
  }
  if (normalizedCharset === "euc-jp" || normalizedCharset === "eucjp") {
    return "EUCJP";
  }
  if (normalizedCharset === "iso-2022-jp") {
    return "JIS";
  }
  return undefined;
}

function normalizeDetectedHtmlCharset(charset: string): HtmlEncodingTarget {
  switch (charset) {
    case "SJIS":
    case "EUCJP":
    case "JIS":
      return charset;
    default:
      return "utf-8";
  }
}

function decodeHtmlBytes(bytes: Uint8Array, charset: HtmlEncodingTarget): string {
  if (charset === "utf-8") {
    return new TextDecoder("utf-8").decode(bytes);
  }

  return Encoding.codeToString(
    Encoding.convert(Array.from(bytes), { to: "UNICODE", from: charset }),
  );
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
  return match ? cleanMetadataText(match[1]) : undefined;
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
  if (!isAllowedPreviewUrl(url)) {
    return undefined;
  }
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "apricot-irc-proxy/0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok || !isAllowedPreviewUrl(resp.url || url)) {
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
    const resolved = new URL(candidate, baseUrl).toString();
    return isAllowedPreviewUrl(resolved) ? resolved : undefined;
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
  return bare ? decodeHtmlEntities(bare[1]) : undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function normalizeTwitterOEmbedText(value?: string): string {
  if (!value) {
    return "";
  }

  const strippedText = value.replace(/<[^>]*>/g, "");
  const cleanedText = cleanMetadataText(strippedText) || "";
  return cleanedText.replace(/\u2014.*$/, "").trim();
}

function cleanXRichEmbedHtml(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.toLowerCase().includes("<blockquote") ? trimmed : undefined;
}

function cleanMetadataText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function buildYouTubeEmbedHtml(embedInfo: YouTubeEmbedInfo): string {
  const height = embedInfo.isShort ? 631 : 200;
  const encodedVideoId = encodeURIComponent(embedInfo.videoId);
  return `<iframe width="355" height="${height}" src="https://www.youtube.com/embed/${encodedVideoId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
}

function extractYouTubeEmbedInfo(url: string): YouTubeEmbedInfo | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "youtu.be") {
    const videoId = parsed.pathname.split("/").filter(Boolean)[0];
    return videoId ? { videoId, isShort: false } : undefined;
  }

  if (hostname === "www.youtube.com" || hostname === "youtube.com" || hostname === "m.youtube.com") {
    if (parsed.pathname === "/watch") {
      const videoId = parsed.searchParams.get("v");
      return videoId ? { videoId, isShort: false } : undefined;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "shorts" && segments[1]) {
      return { videoId: segments[1], isShort: true };
    }
    if ((segments[0] === "live" || segments[0] === "embed") && segments[1]) {
      return { videoId: segments[1], isShort: false };
    }
  }

  return undefined;
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return text;
  }
  return text.substring(0, MAX_MESSAGE_LENGTH - 3) + "...";
}
