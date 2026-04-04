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
import {
  buildAdminCss,
  buildChannelListPage,
  buildSettingsPage,
  buildWebUiSettings,
  createWebModule,
  DEFAULT_WEB_UI_SETTINGS,
  isWebDisplayOrder,
  type PersistedWebLogs,
  type WebUiSettings,
} from "./modules/web";
import { extractUrlMetadata } from "./modules/url-metadata";
import { buildProxyConfigFromEnv, type ProxyConfig } from "./proxy-config";
import LOGIN_TEMPLATE from "./templates/login.html";

const reconnectDelayMs = 5_000;
const webLogsStorageKey = "web:logs:v1";
const webUiSettingsStorageKey = "web:ui-settings:v1";
const webAuthCookieName = "apricot_web_auth";
const nickErrorCodes = new Set(["431", "432", "433", "436", "437", "438", "447", "484", "485"]);

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
  private webUiSettings: WebUiSettings = buildWebUiSettings();

  /** Keepalive alarm interval in ms */
  private keepaliveMs: number;
  private connectPromise: Promise<void> | null = null;
  private suppressAutoReconnectOnClose = false;

  /** Pending NICK change request waiting for server confirmation */
  private pendingNickChange: {
    requestedNick: string;
    resolve: (nick: string) => void;
    reject: (error: string) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.config = buildProxyConfigFromEnv(env);
    this.keepaliveMs = (parseInt(env.KEEPALIVE_INTERVAL || "60", 10)) * 1000;
    if (this.config) {
      this.nick = this.config.server.nick;
    }

    const timezoneOffset = parseFloat(env.TIMEZONE_OFFSET || "9");
    const webLogMaxLines = parseInt(env.WEB_LOG_MAX_LINES || "200", 10);
    this.web = createWebModule(
      this.channelStates,
      timezoneOffset,
      async (logs) => {
        await this.persistWebLogs(logs);
      },
      webLogMaxLines
    );

    // Module registration order matters for QUIT/NICK:
    //   web logs messages first (sees full membership),
    //   then channelTrack removes the member.
    this.modules.register(pingModule);
    this.modules.register(this.web.module);
    this.modules.register(createChannelTrackModule(this.channelStates));
    this.modules.register(createClientSyncModule(this.channelStates));

    void this.state.blockConcurrencyWhile(async () => {
      await this.loadPersistedWebUiSettings();
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
    const isWebSettingsPath = url.pathname === "/web/settings" || url.pathname === "/web/settings/";
    const isProtectedWebRequest = (
      url.pathname === "/web" ||
      url.pathname === "/web/" ||
      /^\/web\/.+$/.test(url.pathname)
    ) && !isWebLoginPath && !isWebLogoutPath;

    if (isProtectedWebRequest && !await this.isWebAuthenticated(request, proxyPrefix)) {
      return this.redirectToWebLogin(webBase);
    }

    // POST /api/connect — connect to IRC server
    if (request.method === "POST" && url.pathname === "/api/connect") {
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

    // GET /api/status — proxy status
    if (request.method === "GET" && url.pathname === "/api/status") {
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

    // POST /api/leave — leave a channel
    if (request.method === "POST" && url.pathname === "/api/leave") {
      return this.handleApiLeave(request);
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

    // GET /api/logs/:channel — retrieve buffered messages for a channel
    const logsMatch = url.pathname.match(/^\/api\/logs\/(.+)$/);
    if (request.method === "GET" && logsMatch) {
      return this.handleApiLogs(decodeURIComponent(logsMatch[1]));
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

    if (isWebSettingsPath && !this.canEditWebSettings()) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET" && isWebSettingsPath) {
      return this.renderWebSettingsPage(webBase);
    }

    if (request.method === "POST" && isWebSettingsPath) {
      return this.handleWebSettings(request, webBase);
    }

    if (isWebSettingsPath) {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/web/display-order" || url.pathname === "/web/display-order/") {
      return new Response("Not found", { status: 404 });
    }

    // POST /web/join — join a channel from web UI
    if (request.method === "POST" && (url.pathname === "/web/join" || url.pathname === "/web/join/")) {
      const formData = await request.formData();
      const channel = (formData.get("channel") as string | null)?.trim() ?? "";
      if (channel && this.serverConn?.connected) {
        await this.serverConn.send({ command: "JOIN", params: [channel] });
      }
      return new Response(null, {
        status: 302,
        headers: { Location: `${webBase}/` },
      });
    }

    // POST /web/leave — leave a channel from web UI
    if (request.method === "POST" && (url.pathname === "/web/leave" || url.pathname === "/web/leave/")) {
      const formData = await request.formData();
      const channel = (formData.get("channel") as string | null)?.trim() ?? "";
      if (channel && this.serverConn?.connected) {
        await this.serverConn.send({ command: "PART", params: [channel] });
      }
      return new Response(null, {
        status: 302,
        headers: { Location: `${webBase}/` },
      });
    }

    // GET /web — channel list
    if (url.pathname === "/web" || url.pathname === "/web/") {
      const html = buildChannelListPage(
        this.channels,
        this.nick,
        this.serverName,
        this.serverConn?.connected ?? false,
        webBase,
        Boolean(this.config?.password),
        this.canEditWebSettings()
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
        Boolean(this.config?.password),
        this.webUiSettings
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

  private async handleApiLeave(request: Request): Promise<Response> {
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
      command: "PART",
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

    let pendingNickChange: NonNullable<IrcProxyDO["pendingNickChange"]>;
    const pendingNickChangePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNickChange = null;
        reject(new Error("timeout waiting for server response"));
      }, 5000);
      pendingNickChange = { requestedNick: nick, resolve, reject, timer };
      this.pendingNickChange = pendingNickChange;
    });

    try {
      await this.serverConn.send({
        command: "NICK",
        params: [nick],
      });
    } catch (err) {
      if (this.pendingNickChange === pendingNickChange!) {
        clearTimeout(pendingNickChange!.timer);
        this.pendingNickChange = null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 502, headers: corsHeaders() });
    }

    let confirmedNick: string;
    try {
      confirmedNick = await pendingNickChangePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 503, headers: corsHeaders() });
    }

    return Response.json({ ok: true, nick: confirmedNick }, { headers: corsHeaders() });
  }

  private resolvePendingNickChange(nick: string): void {
    if (!this.pendingNickChange) return;
    clearTimeout(this.pendingNickChange.timer);
    this.pendingNickChange.resolve(nick);
    this.pendingNickChange = null;
  }

  private rejectPendingNickChange(error: string): void {
    if (!this.pendingNickChange) return;
    clearTimeout(this.pendingNickChange.timer);
    this.pendingNickChange.reject(error);
    this.pendingNickChange = null;
  }

  private handleApiLogs(channel: string): Response {
    const logs = this.web.getChannelLogs(channel);
    if (logs === null) {
      return Response.json(
        { error: "channel not found" },
        { status: 404, headers: corsHeaders() }
      );
    }
    return Response.json({ channel, messages: logs }, { headers: corsHeaders() });
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
    if (cmd === "NICK") {
      const nextNick = msg.params[0];
      const oldNick = msg.prefix?.split("!")[0];
      const matchesPendingNick = this.pendingNickChange &&
        nextNick?.toLowerCase() === this.pendingNickChange.requestedNick.toLowerCase();

      if ((oldNick && oldNick.toLowerCase() === this.nick.toLowerCase()) || matchesPendingNick) {
        this.nick = nextNick;
        this.resolvePendingNickChange(this.nick);
      }
    }

    // Resolve/reject pending NICK change on server error replies
    if (cmd === "FAIL" && this.pendingNickChange && msg.params[0]?.toUpperCase() === "NICK") {
      this.rejectPendingNickChange(msg.params.at(-1) || "nick change failed");
    } else if (nickErrorCodes.has(cmd) && this.pendingNickChange) {
      this.rejectPendingNickChange(msg.params.at(-1) || "nick change failed");
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

  private async loadPersistedWebUiSettings(): Promise<void> {
    const stored = await this.state.storage.get<Partial<WebUiSettings>>(webUiSettingsStorageKey);
    this.webUiSettings = this.normalizeStoredWebUiSettings(stored);
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

  private async persistWebUiSettings(settings: WebUiSettings): Promise<void> {
    this.webUiSettings = settings;
    await this.state.storage.put(webUiSettingsStorageKey, settings);
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

  private canEditWebSettings(): boolean {
    return Boolean(this.config?.password);
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

  private async handleWebSettings(
    request: Request,
    webBase: string
  ): Promise<Response> {
    const formData = await request.formData();
    const validation = this.validateWebUiSettingsForm(formData);
    if (validation.errorMessage) {
      return this.renderWebSettingsPage(webBase, validation.settings, validation.errorMessage, 400);
    }

    await this.persistWebUiSettings(validation.settings);
    return new Response(null, {
      status: 302,
      headers: { Location: `${webBase}/` },
    });
  }

  private validateWebUiSettingsForm(formData: FormData): {
    settings: WebUiSettings;
    errorMessage?: string;
  } {
    const fontFamily = (formData.get("fontFamily") as string | null)?.trim() ?? "";
    if (!fontFamily || fontFamily.length > 200) {
      return {
        settings: { ...this.webUiSettings, fontFamily: fontFamily || this.webUiSettings.fontFamily },
        errorMessage: "Font family は 1〜200 文字で入力してください",
      };
    }

    const fontSizeRaw = (formData.get("fontSizePx") as string | null)?.trim() ?? "";
    const fontSizePx = Number.parseInt(fontSizeRaw, 10);
    if (!Number.isInteger(fontSizePx) || fontSizePx < 10 || fontSizePx > 32) {
      return {
        settings: { ...this.webUiSettings },
        errorMessage: "Font size は 10〜32 の整数で入力してください",
      };
    }

    const textColor = (formData.get("textColor") as string | null)?.trim() ?? "";
    const surfaceColor = (formData.get("surfaceColor") as string | null)?.trim() ?? "";
    const surfaceAltColor = (formData.get("surfaceAltColor") as string | null)?.trim() ?? "";
    const accentColor = (formData.get("accentColor") as string | null)?.trim() ?? "";
    const colors = { textColor, surfaceColor, surfaceAltColor, accentColor } satisfies Record<string, string>;
    for (const [fieldName, value] of Object.entries(colors)) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
        return {
          settings: { ...this.webUiSettings },
          errorMessage: `${fieldName} は #RRGGBB 形式で入力してください`,
        };
      }
    }

    const displayOrder = (formData.get("displayOrder") as string | null)?.trim() ?? "";
    if (!isWebDisplayOrder(displayOrder)) {
      return {
        settings: { ...this.webUiSettings },
        errorMessage: "Display order は asc または desc を指定してください",
      };
    }

    const extraCss = (formData.get("extraCss") as string | null) ?? "";
    if (extraCss.length > 10_240) {
      return {
        settings: { ...this.webUiSettings, fontFamily, fontSizePx, textColor, surfaceColor, surfaceAltColor, accentColor, displayOrder, extraCss },
        errorMessage: "Extra CSS は 10KB 以下にしてください",
      };
    }

    return {
      settings: buildWebUiSettings({
        fontFamily,
        fontSizePx,
        textColor,
        surfaceColor,
        surfaceAltColor,
        accentColor,
        displayOrder,
        extraCss,
      }),
    };
  }

  private normalizeStoredWebUiSettings(stored?: Partial<WebUiSettings>): WebUiSettings {
    if (!stored) {
      return { ...DEFAULT_WEB_UI_SETTINGS };
    }

    const isValidColor = (value: string | undefined): value is string => (
      typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value)
    );
    const fontFamily = typeof stored.fontFamily === "string" && stored.fontFamily.trim() && stored.fontFamily.length <= 200
      ? stored.fontFamily.trim()
      : DEFAULT_WEB_UI_SETTINGS.fontFamily;
    const fontSizePx = Number.isInteger(stored.fontSizePx) && stored.fontSizePx! >= 10 && stored.fontSizePx! <= 32
      ? stored.fontSizePx!
      : DEFAULT_WEB_UI_SETTINGS.fontSizePx;
    const displayOrder = stored.displayOrder && isWebDisplayOrder(stored.displayOrder)
      ? stored.displayOrder
      : DEFAULT_WEB_UI_SETTINGS.displayOrder;
    const extraCss = typeof stored.extraCss === "string" && stored.extraCss.length <= 10_240
      ? stored.extraCss
      : DEFAULT_WEB_UI_SETTINGS.extraCss;

    return buildWebUiSettings({
      fontFamily,
      fontSizePx,
      textColor: isValidColor(stored.textColor) ? stored.textColor : DEFAULT_WEB_UI_SETTINGS.textColor,
      surfaceColor: isValidColor(stored.surfaceColor) ? stored.surfaceColor : DEFAULT_WEB_UI_SETTINGS.surfaceColor,
      surfaceAltColor: isValidColor(stored.surfaceAltColor) ? stored.surfaceAltColor : DEFAULT_WEB_UI_SETTINGS.surfaceAltColor,
      accentColor: isValidColor(stored.accentColor) ? stored.accentColor : DEFAULT_WEB_UI_SETTINGS.accentColor,
      displayOrder,
      extraCss,
    });
  }

  private renderWebSettingsPage(
    webBase: string,
    settings = this.webUiSettings,
    errorMessage = "",
    status = 200
  ): Response {
    const html = buildSettingsPage(
      this.nick,
      this.serverName,
      webBase,
      settings,
      errorMessage
    );

    return new Response(html, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  private renderWebLoginPage(
    actionUrl: string,
    errorMessage = "",
    status = 200
  ): Response {
    const errorHtml = errorMessage
      ? `<div class="admin-message admin-message--danger" role="alert"><strong>ログインに失敗しました。</strong><span>${errorMessage}</span></div>`
      : "";

    const html = LOGIN_TEMPLATE
      .replace("{{CSS}}", buildAdminCss())
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
