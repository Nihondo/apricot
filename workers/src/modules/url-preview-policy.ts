/**
 * URL プレビュー取得前の安全性判定を扱う。
 */

const PRIVATE_IPV6_PREFIXES = ["fc", "fd", "fe8", "fe9", "fea", "feb"];

/**
 * プレビュー取得時に使う fetch タイムアウト。
 */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * HTML の先読み上限バイト数。
 */
export const MAX_HTML_BYTES = 32 * 1024;

/**
 * IRC へ投稿するメタデータ文の最大長。
 */
export const MAX_MESSAGE_LENGTH = 400;

/**
 * メッセージ中の URL を抽出する正規表現。
 */
export const URL_RE = /(https?:\/\/[^\s<>"]+)/g;

/**
 * 直リンク画像として扱う拡張子。
 */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif"]);

/**
 * X / Twitter の URL 判定。
 */
export const X_URL_RE = /^https?:\/\/(?:www\.)?(x|twitter)\.com\//i;

/**
 * X oEmbed の問い合わせ先。
 */
export const X_OEMBED_ENDPOINTS = [
  "https://publish.x.com/oembed",
  "https://publish.twitter.com/oembed",
];

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "::1" || PRIVATE_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * 外向き fetch を許可してよい URL かを判定する。
 */
export function isAllowedPreviewUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  if (parsed.port) {
    const allowedPort = parsed.protocol === "https:" ? "443" : "80";
    if (parsed.port !== allowedPort) {
      return false;
    }
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return false;
  }
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return false;
  }

  return true;
}
