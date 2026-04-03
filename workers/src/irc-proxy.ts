/**
 * IRC Proxy Durable Object.
 * Core proxy logic that manages IRC server connection and WebSocket clients.
 * Mirrors plum's main event loop architecture.
 */

import { parse, build, type IrcMessage } from "./irc-parser";
import { IrcServerConnection } from "./irc-connection";
import { ModuleRegistry } from "./module-system";
import { pingModule } from "./modules/ping";
import { createChannelTrackModule, type ChannelState } from "./modules/channel-track";
import { createClientSyncModule } from "./modules/client-sync";
import { createWebModule, buildChannelListPage, type PersistedWebLogs } from "./modules/web";
import { extractUrlMetadata } from "./modules/url-metadata";
import { buildProxyConfigFromEnv, type ProxyConfig } from "./proxy-config";
import CSS from "./templates/style.css";
import LOGIN_TEMPLATE from "./templates/login.html";

const reconnectDelayMs = 5_000;
const webLogsStorageKey = "web:logs:v1";
const webAuthCookieName = "apricot_web_auth";

export class IrcProxyDO implements DurableObject {
  private state: DurableObjectState;
  private clients = new Set<WebSocket>();
  private serverConn: IrcServerConnection | null = null;
  private modules = new ModuleRegistry();
  private config: ProxyConfig | null = null;
  private nick = "";
  private channels: string[] = [];
  private serverName = "irc";

  /** Per-DO channel state (not shared across DO instances) */
  private channelStates = new Map<string, ChannelState>();

  /** Per-WebSocket pending password during registration */
  private pendingPasswords = new Map<WebSocket, string>();

  /** Web module instance (holds per-DO message buffers) */
  private readonly web: ReturnType<typeof createWebModule>;

  /** Keepalive alarm interval in ms */
  private keepaliveMs: number;
  private connectPromise: Promise<void> | null = null;
  private suppressAutoReconnectOnClose = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.config = buildProxyConfigFromEnv(env);
    this.keepaliveMs = (parseInt(env.KEEPALIVE_INTERVAL || "60", 10)) * 1000;
    if (this.config) {
      this.nick = this.config.server.nick;
    }

    const timezoneOffset = parseFloat(env.TIMEZONE_OFFSET || "9");
    this.web = createWebModule(
      this.channelStates,
      timezoneOffset,
      async (logs) => {
        await this.persistWebLogs(logs);
      }
    );

    // Module registration order matters for QUIT/NICK:
    //   web logs messages first (sees full membership),
    //   then channelTrack removes the member.
    this.modules.register(pingModule);
    this.modules.register(this.web.module);
    this.modules.register(createChannelTrackModule(this.channelStates));
    this.modules.register(createClientSyncModule(this.channelStates));

    void this.state.blockConcurrencyWhile(async () => {
      await this.loadPersistedWebLogs();
      await this.handleStartupAutoConnect();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Base path for web interface URLs (links, form actions, redirects).
    // index.ts injects this header so paths work from the browser's perspective.
    const proxyPrefix = request.headers.get("X-Proxy-Prefix") ?? "";
    const webBase = `${proxyPrefix}/web`;
    const isWebLoginPath = url.pathname === "/web/login" || url.pathname === "/web/login/";
    const isWebLogoutPath = url.pathname === "/web/logout" || url.pathname === "/web/logout/";
    const isProtectedWebRequest = (
      url.pathname === "/web" ||
      url.pathname === "/web/" ||
      /^\/web\/.+$/.test(url.pathname)
    ) && !isWebLoginPath && !isWebLogoutPath;

    if (isProtectedWebRequest && !await this.isWebAuthenticated(request, proxyPrefix)) {
      return this.redirectToWebLogin(webBase);
    }

    // GET /connect — connect to IRC server
    if (url.pathname === "/connect") {
      if (!this.config) {
        return new Response("IRC_HOST not configured", { status: 400 });
      }

      if (this.serverConn?.connected) {
        return new Response("Already connected");
      }

      try {
        await this.ensureServerConnection();
      } catch (err) {
        this.serverConn = null;
        console.error("Failed to connect to IRC server", err);
        return new Response("Failed to connect to IRC server", { status: 502 });
      }
      return new Response("Connecting...");
    }

    // GET /ws — WebSocket client connection
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      this.state.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    // GET /status — proxy status
    if (url.pathname === "/status") {
      return Response.json({
        connected: this.serverConn?.connected ?? false,
        nick: this.nick,
        channels: this.channels,
        clients: this.clients.size,
        serverName: this.serverName,
      });
    }

    // --- API routes ---

    // CORS preflight for API endpoints
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // POST /api/join — join a channel
    if (request.method === "POST" && url.pathname === "/api/join") {
      return this.handleApiJoin(request);
    }

    // POST /api/post — programmatic message posting
    if (request.method === "POST" && url.pathname === "/api/post") {
      return this.handleApiPost(request);
    }

    // POST /api/nick — request a nick change
    if (request.method === "POST" && url.pathname === "/api/nick") {
      return this.handleApiNick(request);
    }

    // POST /api/disconnect — disconnect from IRC server
    if (request.method === "POST" && url.pathname === "/api/disconnect") {
      return this.handleApiDisconnect();
    }

    // --- Web interface routes ---

    // GET /web/login — login form for password-protected web UI
    if (request.method === "GET" && isWebLoginPath) {
      if (await this.isWebAuthenticated(request, proxyPrefix)) {
        return new Response(null, {
          status: 302,
          headers: { Location: `${webBase}/` },
        });
      }
      return this.renderWebLoginPage(`${webBase}/login`);
    }

    // POST /web/login — validate password and set session cookie
    if (request.method === "POST" && isWebLoginPath) {
      return this.handleWebLogin(request, proxyPrefix, webBase);
    }

    // POST /web/logout — clear session cookie
    if (request.method === "POST" && isWebLogoutPath) {
      return this.handleWebLogout(request, proxyPrefix, webBase);
    }

    if (isWebLoginPath || isWebLogoutPath) {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // GET /web — channel list
    if (url.pathname === "/web" || url.pathname === "/web/") {
      const html = buildChannelListPage(
        this.channels,
        this.nick,
        this.serverName,
        this.serverConn?.connected ?? false,
        webBase,
        Boolean(this.config?.password)
      );
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // GET/POST /web/:channel
    const webMatch = url.pathname.match(/^\/web\/(.+)$/);
    if (webMatch) {
      const channel = decodeURIComponent(webMatch[1]);

      // POST — send message
      if (request.method === "POST") {
        const formData = await request.formData();
        const message = formData.get("message") as string | null;

        if (message && message.trim() && this.serverConn?.connected) {
          const text = message.trim();

          await this.serverConn.send({
            command: "PRIVMSG",
            params: [channel, text],
          });

          await this.web.recordSelfMessage(channel, this.nick, text);

          this.broadcast({
            prefix: `${this.nick}!proxy@apricot`,
            command: "PRIVMSG",
            params: [channel, text],
          });
        }

        // PRG: redirect back to channel page using the browser-visible URL
        return new Response(null, {
          status: 302,
          headers: { Location: `${webBase}/${encodeURIComponent(channel)}` },
        });
      }

      // GET — show channel messages
      const topic =
        this.channelStates.get(channel.toLowerCase())?.topic ||
        this.web.getChannelTopic(channel);

      const html = this.web.buildChannelPage(
        channel,
        topic,
        this.nick,
        webBase,
        Boolean(this.config?.password)
      );
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * WebSocket message handler — called by Durable Object runtime.
   */
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") return;

    // Handle multiple lines (some clients batch commands)
    const lines = message.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "").trim();
      if (!line) continue;

      const msg = parse(line);
      if (!msg.command) continue;

      // Handle client authentication / registration
      if (!this.clients.has(ws)) {
        await this.handleClientRegistration(ws, msg);
        continue;
      }

      // Process through modules (cs_* handlers)
      const event = `cs_${msg.command.toLowerCase()}`;
      const ctx = this.makeContext(0);
      const result = await this.modules.dispatchScan(event, ctx, msg);

      // Forward to server if not dropped
      if (result && this.serverConn?.connected) {
        await this.serverConn.send(result);
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    this.clients.delete(ws);
    this.pendingPasswords.delete(ws);
    const ctx = this.makeContext(0);
    await this.modules.dispatchLifecycle("onClientClose", ctx);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.clients.delete(ws);
    this.pendingPasswords.delete(ws);
  }

  /**
   * Alarm handler — keeps the DO alive while IRC connection is active.
   * Without this, the DO is evicted after ~2 min of idle and the TCP socket dies.
   */
  async alarm(): Promise<void> {
    if (this.serverConn?.connected) {
      await this.scheduleKeepaliveAlarm();
      return;
    }

    if (!this.config?.autoReconnectOnDisconnect) {
      return;
    }

    try {
      await this.ensureServerConnection();
    } catch (error) {
      console.error("Failed to reconnect to IRC server", error);
      await this.scheduleReconnectAlarm();
    }
  }

  // --- API methods ---

  private async handleApiJoin(request: Request): Promise<Response> {
    let body: { channel?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "invalid JSON" },
        { status: 400, headers: corsHeaders() }
      );
    }

    const channel = body.channel;
    if (!channel) {
      return Response.json(
        { error: "missing channel" },
        { status: 400, headers: corsHeaders() }
      );
    }

    if (!this.serverConn?.connected) {
      return Response.json(
        { error: "not connected to IRC server" },
        { status: 503, headers: corsHeaders() }
      );
    }

    await this.serverConn.send({
      command: "JOIN",
      params: [channel],
    });

    return Response.json({ ok: true, channel }, { headers: corsHeaders() });
  }

  private async handleApiPost(request: Request): Promise<Response> {
    let body: { channel?: string; message?: string; url?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "invalid JSON" },
        { status: 400, headers: corsHeaders() }
      );
    }

    const channel = body.channel;
    if (!channel) {
      return Response.json(
        { error: "missing channel" },
        { status: 400, headers: corsHeaders() }
      );
    }

    let text = body.message || "";

    // URL metadata extraction mode
    if (!text && body.url) {
      try {
        text = await extractUrlMetadata(body.url);
      } catch {
        text = body.url;
      }
    }

    if (!text) {
      return Response.json(
        { error: "missing message or url" },
        { status: 400, headers: corsHeaders() }
      );
    }

    if (!this.serverConn?.connected) {
      return Response.json(
        { error: "not connected to IRC server" },
        { status: 503, headers: corsHeaders() }
      );
    }

    await this.serverConn.send({
      command: "PRIVMSG",
      params: [channel, text],
    });

    await this.web.recordSelfMessage(channel, this.nick, text);

    this.broadcast({
      prefix: `${this.nick}!proxy@apricot`,
      command: "PRIVMSG",
      params: [channel, text],
    });

    return Response.json({ ok: true, message: text, channel }, { headers: corsHeaders() });
  }

  private async handleApiNick(request: Request): Promise<Response> {
    let body: { nick?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "invalid JSON" },
        { status: 400, headers: corsHeaders() }
      );
    }

    const nick = body.nick?.trim();
    if (!nick) {
      return Response.json(
        { error: "missing nick" },
        { status: 400, headers: corsHeaders() }
      );
    }

    if (!this.serverConn?.connected) {
      return Response.json(
        { error: "not connected to IRC server" },
        { status: 503, headers: corsHeaders() }
      );
    }

    await this.serverConn.send({
      command: "NICK",
      params: [nick],
    });

    return Response.json({ ok: true, nick }, { headers: corsHeaders() });
  }

  private async handleApiDisconnect(): Promise<Response> {
    if (!this.serverConn?.connected) {
      return Response.json(
        { error: "not connected to IRC server" },
        { status: 503, headers: corsHeaders() }
      );
    }

    this.suppressAutoReconnectOnClose = true;
    await this.state.storage.deleteAlarm();
    await this.serverConn.close();

    return Response.json({ ok: true }, { headers: corsHeaders() });
  }

  // --- Private methods ---

  private async handleClientRegistration(
    ws: WebSocket,
    msg: IrcMessage
  ): Promise<void> {
    const cmd = msg.command.toUpperCase();

    if (cmd === "PASS") {
      // Store password for validation when USER arrives
      this.pendingPasswords.set(ws, msg.params[0] || "");
      return;
    }

    if (cmd === "NICK") {
      // Noted but ignored — proxy uses its own nick
      return;
    }

    if (cmd === "USER") {
      // Validate password if configured
      const configPassword = this.config?.password;
      if (configPassword) {
        const submitted = this.pendingPasswords.get(ws) ?? "";
        this.pendingPasswords.delete(ws);
        if (submitted !== configPassword) {
          ws.send(
            build({
              prefix: "apricot",
              command: "464",
              params: ["*", "Password incorrect"],
            })
          );
          ws.close(1008, "Password incorrect");
          return;
        }
      } else {
        this.pendingPasswords.delete(ws);
      }

      // Registration complete — add client
      this.clients.add(ws);

      // Auto-connect to server if not connected
      if (!this.serverConn && this.config) {
        await this.ensureServerConnection();
      }

      // Fire client_open lifecycle to sync state
      const ctx = this.makeClientContext(ws);
      await this.modules.dispatchLifecycle("onClientOpen", ctx);
      return;
    }

    // Unknown command before registration
    ws.send(
      build({
        prefix: "apricot",
        command: "451",
        params: ["*", "You have not registered"],
      })
    );
  }

  private async connectToServer(): Promise<void> {
    if (!this.config) return;

    const { ports } = this.config;
    let lastError: unknown;

    for (const port of ports) {
      const cfg = { ...this.config.server, port };

      this.serverConn = new IrcServerConnection(
        cfg,
        // onMessage — handle messages from IRC server
        async (msg) => {
          await this.handleServerMessage(msg);
        },
        // onClose
        async () => {
          const ctx = this.makeContext(0);
          await this.modules.dispatchLifecycle("onServerClose", ctx);
          this.serverConn = null;
          await this.persistCurrentWebLogs();

          // Stop keepalive alarm
          await this.state.storage.deleteAlarm();

          // Notify clients
          this.broadcast({
            prefix: "apricot",
            command: "NOTICE",
            params: ["*", "Disconnected from IRC server"],
          });

          if (this.consumeAutoReconnectOnClose()) {
            await this.scheduleReconnectAlarm();
          }
        }
      );

      try {
        await this.serverConn.connect();
        return; // Success
      } catch (err) {
        console.error(`IRC: failed to connect on port ${port}`, err);
        lastError = err;
        this.serverConn = null;
      }
    }

    throw lastError;
  }

  private async handleServerMessage(msg: IrcMessage): Promise<void> {
    const cmd = msg.command;

    // Handle 001 RPL_WELCOME — server registration complete
    if (cmd === "001") {
      this.serverConn?.markConnected();
      this.serverName = msg.prefix || "irc";
      if (msg.params[0]) {
        this.nick = msg.params[0];
      }
      const ctx = this.makeContext(0);
      await this.modules.dispatchLifecycle("onServerOpen", ctx);

      // Start keepalive alarm to prevent DO eviction
      await this.scheduleKeepaliveAlarm();

      // Autojoin configured channels
      if (this.config?.autojoin?.length && this.serverConn) {
        for (const channel of this.config.autojoin) {
          await this.serverConn.send({ command: "JOIN", params: [channel] });
        }
      }
    }

    // Handle NICK change for self
    if (cmd === "NICK" && msg.prefix) {
      const oldNick = msg.prefix.split("!")[0];
      if (oldNick.toLowerCase() === this.nick.toLowerCase()) {
        this.nick = msg.params[0];
      }
    }

    // Dispatch through modules (ss_* handlers)
    const event = `ss_${cmd.toLowerCase()}`;
    const ctx = this.makeContext(0);
    const result = await this.modules.dispatchScan(event, ctx, msg);

    // Forward to all clients if not dropped
    if (result) {
      this.broadcast(result);
    }
  }

  private broadcast(msg: IrcMessage): void {
    const line = build(msg);
    for (const ws of this.clients) {
      try {
        ws.send(line);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  private makeContext(connno: number) {
    return {
      userno: 0,
      connno,
      sendToServer: async (msg: IrcMessage): Promise<void> => {
        if (this.serverConn) await this.serverConn.send(msg);
      },
      sendToClients: (msg: IrcMessage): void => {
        this.broadcast(msg);
      },
      getProperty: (_key: string): string | undefined => undefined,
      nick: this.nick,
      channels: this.channels,
      serverName: this.serverName,
    };
  }

  private makeClientContext(ws: WebSocket) {
    return {
      ...this.makeContext(0),
      sendToClients: (msg: IrcMessage): void => {
        try {
          ws.send(build(msg));
        } catch {
          this.clients.delete(ws);
        }
      },
    };
  }

  private async handleStartupAutoConnect(): Promise<void> {
    if (!this.config?.autoConnectOnStartup) return;

    try {
      await this.ensureServerConnection();
    } catch (error) {
      console.error("Failed to auto-connect on startup", error);
      if (this.config.autoReconnectOnDisconnect) {
        await this.scheduleReconnectAlarm();
      }
    }
  }

  private async ensureServerConnection(): Promise<void> {
    if (!this.config || this.serverConn) return;

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    const pendingConnection = this.connectToServer();
    this.connectPromise = pendingConnection;

    try {
      await pendingConnection;
    } finally {
      if (this.connectPromise === pendingConnection) {
        this.connectPromise = null;
      }
    }
  }

  private async scheduleKeepaliveAlarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + this.keepaliveMs);
  }

  private async scheduleReconnectAlarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + reconnectDelayMs);
  }

  private consumeAutoReconnectOnClose(): boolean {
    const shouldReconnect = Boolean(this.config?.autoReconnectOnDisconnect)
      && !this.suppressAutoReconnectOnClose;
    this.suppressAutoReconnectOnClose = false;
    return shouldReconnect;
  }

  private async handleWebLogin(
    request: Request,
    proxyPrefix: string,
    webBase: string
  ): Promise<Response> {
    if (!this.config?.password) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${webBase}/` },
      });
    }

    const formData = await request.formData();
    const password = (formData.get("password") as string | null)?.trim() ?? "";
    if (password !== this.config.password) {
      return this.renderWebLoginPage(`${webBase}/login`, "パスワードが違います", 401);
    }

    const cookieValue = await this.buildWebAuthCookieValue(proxyPrefix);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${webBase}/`,
        "Set-Cookie": this.buildWebAuthCookie(cookieValue, `${proxyPrefix}/web`, request.url),
      },
    });
  }

  private async handleWebLogout(
    request: Request,
    proxyPrefix: string,
    webBase: string
  ): Promise<Response> {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${webBase}/login`,
        "Set-Cookie": this.buildExpiredWebAuthCookie(`${proxyPrefix}/web`, request.url),
      },
    });
  }

  private async loadPersistedWebLogs(): Promise<void> {
    const logs = await this.state.storage.get<PersistedWebLogs>(webLogsStorageKey);
    this.web.hydrateLogs(logs ?? null);
  }

  private async persistCurrentWebLogs(): Promise<void> {
    await this.persistWebLogs(this.web.snapshotLogs());
  }

  private async persistWebLogs(logs: PersistedWebLogs): Promise<void> {
    try {
      await this.state.storage.put(webLogsStorageKey, logs);
    } catch (error) {
      console.error("Failed to persist web logs", error);
    }
  }

  private async isWebAuthenticated(request: Request, proxyPrefix: string): Promise<boolean> {
    if (!this.config?.password) {
      return true;
    }

    const cookies = this.parseCookies(request.headers.get("Cookie"));
    const actual = cookies.get(webAuthCookieName);
    if (!actual) {
      return false;
    }

    const expected = await this.buildWebAuthCookieValue(proxyPrefix);
    return actual === expected;
  }

  private parseCookies(cookieHeader: string | null): Map<string, string> {
    const cookies = new Map<string, string>();
    if (!cookieHeader) {
      return cookies;
    }

    for (const entry of cookieHeader.split(";")) {
      const [rawName, ...rawValue] = entry.trim().split("=");
      if (!rawName) continue;
      cookies.set(rawName, rawValue.join("="));
    }
    return cookies;
  }

  private async buildWebAuthCookieValue(proxyPrefix: string): Promise<string> {
    const source = `${proxyPrefix}:${this.config?.password ?? ""}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  private buildWebAuthCookie(value: string, path: string, requestUrl: string): string {
    const isSecure = new URL(requestUrl).protocol === "https:";
    return [
      `${webAuthCookieName}=${value}`,
      `Path=${path}`,
      "HttpOnly",
      "SameSite=Strict",
      ...(isSecure ? ["Secure"] : []),
    ].join("; ");
  }

  private buildExpiredWebAuthCookie(path: string, requestUrl: string): string {
    const isSecure = new URL(requestUrl).protocol === "https:";
    return [
      `${webAuthCookieName}=`,
      `Path=${path}`,
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
      ...(isSecure ? ["Secure"] : []),
    ].join("; ");
  }

  private renderWebLoginPage(
    actionUrl: string,
    errorMessage = "",
    status = 200
  ): Response {
    const errorHtml = errorMessage
      ? `<div class="login-error">${errorMessage}</div>`
      : "";

    const html = LOGIN_TEMPLATE
      .replace("{{CSS}}", CSS)
      .replace("{{ERROR}}", errorHtml)
      .replace("{{ACTION_URL}}", actionUrl);

    return new Response(html, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  private redirectToWebLogin(webBase: string): Response {
    return new Response(null, {
      status: 302,
      headers: { Location: `${webBase}/login` },
    });
  }
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
