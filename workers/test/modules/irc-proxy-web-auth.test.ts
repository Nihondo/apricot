import { describe, expect, it } from "vitest";
import {
  buildExpiredWebAuthCookie,
  buildWebAuthCookie,
  buildWebAuthCookieValue,
  isWebAuthenticated,
  parseCookies,
  redirectToWebLogin,
} from "../../src/irc-proxy/web-auth";

describe("irc-proxy/web-auth", () => {
  it("parses cookie headers into a map", () => {
    const cookies = parseCookies("foo=bar; apricot_web_auth=token; theme=light");

    expect(cookies.get("foo")).toBe("bar");
    expect(cookies.get("apricot_web_auth")).toBe("token");
    expect(cookies.get("theme")).toBe("light");
  });

  it("builds and expires auth cookies with secure attributes", () => {
    const cookie = buildWebAuthCookie("token", "/proxy/main/web", "https://example.com/web/login");
    const expiredCookie = buildExpiredWebAuthCookie("/proxy/main/web", "https://example.com/web/logout");

    expect(cookie).toContain("apricot_web_auth=token");
    expect(cookie).toContain("Path=/proxy/main/web");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(expiredCookie).toContain("Max-Age=0");
    expect(expiredCookie).toContain("Secure");
  });

  it("authenticates requests from the derived cookie value", async () => {
    const proxyPrefix = "/proxy/main";
    const password = "secret";
    const cookieValue = await buildWebAuthCookieValue(proxyPrefix, password);

    const ok = await isWebAuthenticated(new Request("https://example.com/web", {
      headers: { Cookie: `apricot_web_auth=${cookieValue}` },
    }), proxyPrefix, password);
    const ng = await isWebAuthenticated(new Request("https://example.com/web", {
      headers: { Cookie: "apricot_web_auth=invalid" },
    }), proxyPrefix, password);

    expect(ok).toBe(true);
    expect(ng).toBe(false);
  });

  it("redirects unauthenticated requests to the login page", () => {
    const response = redirectToWebLogin("/proxy/main/web");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/proxy/main/web/login");
  });
});
