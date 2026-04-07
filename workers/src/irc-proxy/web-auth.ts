/**
 * Web UI の認証 cookie と判定ロジック。
 */

import { redirectResponse } from "./response";

export const WEB_AUTH_COOKIE_NAME = "apricot_web_auth";

/**
 * Cookie ヘッダを名前ごとの Map に変換する。
 */
export function parseCookies(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const entry of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies.set(rawName, rawValue.join("="));
  }
  return cookies;
}

/**
 * proxyPrefix とパスワードから認証 cookie 値を導出する。
 */
export async function buildWebAuthCookieValue(proxyPrefix: string, password: string): Promise<string> {
  const source = `${proxyPrefix}:${password}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 有効な認証 cookie を組み立てる。
 */
export function buildWebAuthCookie(value: string, path: string, requestUrl: string): string {
  const isSecure = new URL(requestUrl).protocol === "https:";
  return [
    `${WEB_AUTH_COOKIE_NAME}=${value}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(isSecure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * 認証 cookie を失効させる Set-Cookie 値を組み立てる。
 */
export function buildExpiredWebAuthCookie(path: string, requestUrl: string): string {
  const isSecure = new URL(requestUrl).protocol === "https:";
  return [
    `${WEB_AUTH_COOKIE_NAME}=`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(isSecure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * 現在のリクエストが Web UI 認証済みかを判定する。
 */
export async function isWebAuthenticated(
  request: Request,
  proxyPrefix: string,
  password?: string,
): Promise<boolean> {
  if (!password) {
    return true;
  }

  const actual = parseCookies(request.headers.get("Cookie")).get(WEB_AUTH_COOKIE_NAME);
  if (!actual) {
    return false;
  }

  const expected = await buildWebAuthCookieValue(proxyPrefix, password);
  return actual === expected;
}

/**
 * Web UI のログイン画面へ 302 リダイレクトする。
 */
export function redirectToWebLogin(webBase: string): Response {
  return redirectResponse(`${webBase}/login`);
}
