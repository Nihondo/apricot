/**
 * URL metadata extraction utility.
 * Fetches page titles and tweet text for URLs, similar to ircpost.cgi.
 */

const MAX_MESSAGE_LENGTH = 400;

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

async function extractTwitterMetadata(url: string): Promise<string> {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;

  const resp = await fetch(oembedUrl, {
    headers: { "User-Agent": "apricot-irc-proxy/0.1" },
    signal: AbortSignal.timeout(10_000),
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
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "apricot-irc-proxy/0.1",
      Accept: "text/html",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    return url;
  }

  const contentType = resp.headers.get("Content-Type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    return url;
  }

  // Read only the first 32KB to find <title>
  const reader = resp.body?.getReader();
  if (!reader) return url;

  let html = "";
  const decoder = new TextDecoder();
  const maxBytes = 32 * 1024;

  try {
    let totalRead = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      totalRead += value.byteLength;
      // Stop once we have enough to find <title> or hit limit
      if (totalRead >= maxBytes || /<\/title>/i.test(html)) break;
    }
  } finally {
    await reader.cancel();
  }

  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match) {
    const title = match[1]
      .replace(/\s+/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec)))
      .trim();

    if (title) {
      return truncate(`${title} ${url}`);
    }
  }

  return url;
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.substring(0, MAX_MESSAGE_LENGTH - 3) + "...";
}
