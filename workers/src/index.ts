import FAVICON_ICO from "../favicon.ico";

/**
 * Cloudflare Worker entry point for apricot IRC Proxy.
 *
 * Routes:
 *   POST /proxy/:id/api/connect — Connect proxy to IRC server (Bearer auth)
 *   GET  /proxy/:id/ws      — WebSocket endpoint for IRC clients
 *   GET  /proxy/:id/api/status — Get proxy status (Bearer auth)
 *   GET  /proxy/:id/web/    — Web chat interface (channel list)
 *   GET  /proxy/:id/web/:ch — Web chat shell
 *   GET  /proxy/:id/web/:ch/messages — Web chat message pane
 *   GET  /proxy/:id/web/:ch/composer — Web chat composer pane
 *   GET  /proxy/:id/web/login — Web UI login form
 *   POST /proxy/:id/web/config — Web UI persisted proxy config save
 *   POST /proxy/:id/web/:ch/composer — Send message via web interface
 *   POST /proxy/:id/web/login — Web UI login
 *   POST /proxy/:id/web/logout — Web UI logout
 *   POST /proxy/:id/api/join — Join a channel (Bearer auth)
 *   POST /proxy/:id/api/leave — Leave a channel (Bearer auth)
 *   POST /proxy/:id/api/post — Programmatic message posting (Bearer auth)
 *   POST /proxy/:id/api/nick — Change IRC nick (Bearer auth)
 *   PUT  /proxy/:id/api/config — Persist per-proxy defaults (Bearer auth)
 *   POST /proxy/:id/api/disconnect — Disconnect from IRC server (Bearer auth)
 *   GET  /proxy/:id/api/logs/:channel — Retrieve buffered messages for a channel (Bearer auth)
 *   GET  /favicon.ico            — Site favicon
 *   GET  /                   — Health check
 */

export { IrcProxyDO } from "./irc-proxy";

// Env is declared globally via src/env.d.ts

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/" || path === "/health") {
      return Response.json({
        name: "apricot-irc-proxy",
        version: "0.1.0",
        status: "ok",
      });
    }

    if (path === "/favicon.ico") {
      return new Response(FAVICON_ICO, {
        headers: {
          "Content-Type": "image/x-icon",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Route: /proxy/:id/<action>
    const match = path.match(/^\/proxy\/([^/]+)(\/.*)?$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }

    const proxyId = match[1];
    const subpath = match[2] || "/";

    const isApiRoute = subpath.startsWith("/api/");
    if (isApiRoute && request.method !== "OPTIONS") {
      if (!env.API_KEY) {
        return Response.json({ error: "API_KEY not configured" }, { status: 503 });
      }
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.API_KEY}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    // Get or create Durable Object for this proxy session
    const id = env.IRC_PROXY.idFromName(proxyId);
    const stub = env.IRC_PROXY.get(id);

    // Forward request to the Durable Object.
    // Pass the original proxy prefix so the DO can generate correct URLs
    // for web interface links, form actions, and redirects.
    const doUrl = new URL(request.url);
    doUrl.pathname = subpath;

    const headers = new Headers(request.headers);
    headers.set("X-Proxy-Prefix", `/proxy/${proxyId}`);
    headers.set("X-Proxy-Id", proxyId);

    return stub.fetch(
      new Request(doUrl.toString(), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
        redirect: "manual",
      })
    );
  },
} satisfies ExportedHandler<Env>;
