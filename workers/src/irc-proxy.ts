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
  buildWebAppHead,
  buildCustomThemeCss,
  buildChannelListPage,
  buildSettingsPage,
  buildWebUiSettings,
  createWebModule,
  DEFAULT_WEB_UI_SETTINGS,
  LIGHT_WEB_UI_COLOR_PRESET,
  isWebDisplayOrder,
  resolveXEmbedTheme,
  sanitizeStoredCustomCss,
  type PersistedWebLogs,
  type WebUiColorSettings,
  type WebUiSettings,
} from "./modules/web";
import {
  type BrowserRenderingConfig,
  extractUrlMetadata,
  resolveUrlEmbed,
  type ResolvedUrlEmbed,
} from "./modules/url-metadata";
import {
  validateChannelInput,
  validateMessageInput,
  validateNickInput,
  validatePasswordInput,
} from "./input-validation";
import {
  buildProxyConfigFromEnv,
  resolveProxyConfig,
  type ProxyConfig,
  type ProxyInstanceConfig,
} from "./proxy-config";
import { escapeUnsupportedIrcText } from "./irc-text-escape";
import { sanitizeCustomCss } from "./custom-css";
import APRICOT_APP_ICON_PNG from "./assets/apricot_app_icon.png";
import APRICOT_LOGO_PNG from "./assets/apricot_logo.png";
import LOGIN_TEMPLATE from "./templates/login.html";

const reconnectDelayMs = 5_000;
const proxyConfigStorageKey = "proxy:config:v1";
const proxyIdStorageKey = "proxy:id";
const webLogsStorageKey = "web:logs:v1";
const webUiSettingsStorageKey = "web:ui-settings:v1";
const webAuthCookieName = "apricot_web_auth";
const nickErrorCodes = new Set(["431", "432", "433", "436", "437", "438", "447", "484", "485"]);
type WebChannelUpdateMessage = {
  type: "channel-updated";
  channel: string;
  revision: number;
};
type WebHeartbeatPingMessage = {
  type: "ping";
};
type WebHeartbeatPongMessage = {
  type: "pong";
};
type WebUpdateSocketMessage =
  | WebChannelUpdateMessage
  | WebHeartbeatPingMessage
  | WebHeartbeatPongMessage;
const webUiColorFieldNames: Array<keyof WebUiColorSettings> = [
  "textColor",
  "surfaceColor",
  "surfaceAltColor",
  "accentColor",
  "borderColor",
  "usernameColor",
  "timestampColor",
  "highlightColor",
  "buttonColor",
  "buttonTextColor",
  "selfColor",
  "mutedTextColor",
  "keywordColor",
];

export class IrcProxyDO implements DurableObject {
  private state: DurableObjectState;
  private clients = new Set<WebSocket>();
  private serverConn: IrcServerConnection | null = null;
  private modules = new ModuleRegistry();
  private readonly envConfig: ProxyConfig | null;
  private readonly browserRenderingConfig?: BrowserRenderingConfig;
  private config: ProxyConfig | null = null;
  private instanceConfig?: ProxyInstanceConfig;
  private proxyId: string | null = null;
  private nick = "";
  private channels: string[] = [];
  private serverName = "irc";

  /** Per-DO channel state (not shared across DO instances) */
  private channelStates = new Map<string, ChannelState>();

  /** Per-WebSocket pending password during registration */
  private pendingPasswords = new Map<WebSocket, string>();
  private webUpdateSubscribers = new Map<WebSocket, string>();
  private channelRevisions = new Map<string, number>();

  /** Web module instance (holds per-DO message buffers) */
  private readonly web: ReturnType<typeof createWebModule>;
  private webUiSettings: WebUiSettings = buildWebUiSettings();

  /** Keepalive alarm interval in ms */
  private keepaliveMs: number;
  private hasInitializedProxyConfig = false;
  private hasAttemptedStartupAutoConnect = false;
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
    this.envConfig = buildProxyConfigFromEnv(env);
    this.browserRenderingConfig = buildBrowserRenderingConfig(env);
    this.config = this.envConfig;
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
      webLogMaxLines,
      (channels) => {
        this.handleChannelLogsChanged(channels);
      },
      this.config?.enableRemoteUrlPreview ?? false,
      () => this.webUiSettings,
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
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureProxyConfigInitialized(request);
    await this.handleStartupAutoConnect();

    const url = new URL(request.url);
    const webUpdatesMatch = url.pathname.match(/^\/web\/(.+)\/updates\/?$/);

    // Base path for web interface URLs (links, form actions, redirects).
    // index.ts injects this header so paths work from the browser's perspective.
    const proxyPrefix = request.headers.get("X-Proxy-Prefix") ?? "";
    const webBase = `${proxyPrefix}/web`;
    const isWebLoginPath = url.pathname === "/web/login" || url.pathname === "/web/login/";
    const isWebLogoutPath = url.pathname === "/web/logout" || url.pathname === "/web/logout/";
    const isWebSettingsPath = url.pathname === "/web/settings" || url.pathname === "/web/settings/";
    const isWebConfigPath = url.pathname === "/web/config" || url.pathname === "/web/config/";
    const isWebThemePath = url.pathname === "/web/theme.css" || url.pathname === "/web/theme.css/";
    const isWebManifestPath = url.pathname === "/web/manifest.webmanifest";
    const isWebAppIconPath = url.pathname === "/web/assets/app-icon.png";
    const isWebLogoPath = url.pathname === "/web/assets/apricot-logo.png";
    const isWebRequest = url.pathname === "/web"
      || url.pathname === "/web/"
      || url.pathname === "/ws"
      || /^\/web\/.+$/.test(url.pathname);
    const isProtectedWebRequest = (
      url.pathname === "/web" ||
      url.pathname === "/web/" ||
      /^\/web\/.+$/.test(url.pathname)
    ) && !isWebLoginPath
      && !isWebLogoutPath
      && !isWebThemePath
      && !isWebManifestPath
      && !isWebAppIconPath
      && !isWebLogoPath;
    const isProtectedWebAssetRequest = Boolean(webUpdatesMatch) || isWebThemePath || isWebLogoPath;

    if (isWebRequest && !this.config?.password) {
      return new Response("CLIENT_PASSWORD not configured", { status: 503 });
    }

    if (isProtectedWebAssetRequest && !await this.isWebAuthenticated(request, proxyPrefix)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (isProtectedWebRequest && !webUpdatesMatch && !await this.isWebAuthenticated(request, proxyPrefix)) {
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
      }, { headers: corsHeaders() });
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

    // PUT /api/config — persist per-proxy default config
    if (request.method === "PUT" && url.pathname === "/api/config") {
      return this.handleApiConfig(request);
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

    if (request.method === "GET" && isWebThemePath) {
      return this.renderWebThemeCss();
    }

    if (request.method === "GET" && isWebManifestPath) {
      return this.renderWebManifest(webBase);
    }

    if (request.method === "GET" && isWebAppIconPath) {
      return new Response(APRICOT_APP_ICON_PNG, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    if (request.method === "GET" && isWebLogoPath) {
      return new Response(APRICOT_LOGO_PNG, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=86400",
        },
      });
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

    if (request.method === "POST" && isWebConfigPath) {
      return this.handleWebConfig(request, webBase);
    }

    if (isWebConfigPath) {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/web/display-order" || url.pathname === "/web/display-order/") {
      return new Response("Not found", { status: 404 });
    }

    // POST /web/join — join a channel from web UI
    if (request.method === "POST" && (url.pathname === "/web/join" || url.pathname === "/web/join/")) {
      const formData = await request.formData();
      const channelResult = validateChannelInput(formData.get("channel") as string | null);
      if (!channelResult.ok) {
        return new Response(
          this.buildWebChannelListPage(webBase, {
            flashMessage: `JOIN に失敗しました: ${channelResult.error}`,
            flashTone: "danger",
          }),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      if (!this.serverConn?.connected) {
        return new Response(
          this.buildWebChannelListPage(webBase, {
            flashMessage: "JOIN に失敗しました: not connected to IRC server",
            flashTone: "danger",
          }),
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      await this.serverConn.send({ command: "JOIN", params: [channelResult.value] });
      return new Response(null, {
        status: 302,
        headers: { Location: `${webBase}/` },
      });
    }

    // POST /web/leave — leave a channel from web UI
    if (request.method === "POST" && (url.pathname === "/web/leave" || url.pathname === "/web/leave/")) {
      const formData = await request.formData();
      const channelResult = validateChannelInput(formData.get("channel") as string | null);
      if (!channelResult.ok) {
        return new Response(
          this.buildWebChannelListPage(webBase, {
            flashMessage: `PART に失敗しました: ${channelResult.error}`,
            flashTone: "danger",
          }),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      if (!this.serverConn?.connected) {
        return new Response(
          this.buildWebChannelListPage(webBase, {
            flashMessage: "PART に失敗しました: not connected to IRC server",
            flashTone: "danger",
          }),
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      await this.serverConn.send({ command: "PART", params: [channelResult.value] });
      return new Response(null, {
        status: 302,
        headers: { Location: `${webBase}/` },
      });
    }

    // POST /web/nick — change nick from web UI
    if (request.method === "POST" && (url.pathname === "/web/nick" || url.pathname === "/web/nick/")) {
      return this.handleWebNick(request, webBase);
    }

    // GET /web — channel list
    if (url.pathname === "/web" || url.pathname === "/web/") {
      const html = this.buildWebChannelListPage(webBase);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const webMessagesFragmentMatch = url.pathname.match(/^\/web\/(.+)\/messages\/fragment\/?$/);
    if (webMessagesFragmentMatch) {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return this.renderWebChannelMessagesFragment(
        decodeURIComponent(webMessagesFragmentMatch[1])
      );
    }

    const webMessagesMatch = url.pathname.match(/^\/web\/(.+)\/messages\/?$/);
    if (webMessagesMatch) {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return this.renderWebChannelMessagesPage(
        decodeURIComponent(webMessagesMatch[1]),
        webBase
      );
    }

    if (webUpdatesMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      return this.acceptWebUpdatesSocket(decodeURIComponent(webUpdatesMatch[1]));
    }

    const webComposerMatch = url.pathname.match(/^\/web\/(.+)\/composer\/?$/);
    if (webComposerMatch) {
      const channel = decodeURIComponent(webComposerMatch[1]);
      if (request.method === "GET") {
        return this.renderWebChannelComposerPage(channel, webBase);
      }
      if (request.method === "POST") {
        return this.handleWebChannelComposer(request, channel, webBase);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    // GET /web/:channel
    const webMatch = url.pathname.match(/^\/web\/(.+)\/?$/);
    if (webMatch) {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return this.renderWebChannelShellPage(decodeURIComponent(webMatch[1]), webBase);
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
    if (this.webUpdateSubscribers.has(ws)) {
      if (typeof message !== "string") {
        return;
      }
      try {
        const payload = JSON.parse(message) as Partial<WebUpdateSocketMessage>;
        if (payload.type === "ping") {
          const pongMessage: WebHeartbeatPongMessage = { type: "pong" };
          ws.send(JSON.stringify(pongMessage));
        }
      } catch {}
      return;
    }

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
        try {
          await this.serverConn.send(result);
        } catch {
          ws.close(1008, "Invalid IRC message");
          return;
        }
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    if (this.webUpdateSubscribers.delete(ws)) {
      return;
    }
    this.clients.delete(ws);
    this.pendingPasswords.delete(ws);
    const ctx = this.makeContext(0);
    await this.modules.dispatchLifecycle("onClientClose", ctx);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    if (this.webUpdateSubscribers.delete(ws)) {
      return;
    }
    this.clients.delete(ws);
    this.pendingPasswords.delete(ws);
  }

  /**
   * Alarm handler — keeps the DO alive while IRC connection is active.
   * Without this, the DO is evicted after ~2 min of idle and the TCP socket dies.
   */
  async alarm(): Promise<void> {
    await this.ensureProxyConfigInitialized();

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

    const channelResult = validateChannelInput(body.channel);
    if (!channelResult.ok) {
      return Response.json(
        { error: channelResult.error },
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
      params: [channelResult.value],
    });

    return Response.json({ ok: true, channel: channelResult.value }, { headers: corsHeaders() });
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

    const channelResult = validateChannelInput(body.channel);
    if (!channelResult.ok) {
      return Response.json(
        { error: channelResult.error },
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
      params: [channelResult.value],
    });

    return Response.json({ ok: true, channel: channelResult.value }, { headers: corsHeaders() });
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

    const channelResult = validateChannelInput(body.channel);
    if (!channelResult.ok) {
      return Response.json(
        { error: channelResult.error },
        { status: 400, headers: corsHeaders() }
      );
    }

    let text = body.message || "";
    let embed: ResolvedUrlEmbed | undefined;

    // URL metadata extraction mode
    if (!text && body.url) {
      try {
        embed = await resolveUrlEmbed(body.url, {
          xTheme: resolveXEmbedTheme(this.webUiSettings.surfaceColor),
        });
      } catch {
        embed = undefined;
      }

      try {
        text = await extractUrlMetadata(body.url, {
          browserRendering: this.browserRenderingConfig,
        });
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

    const postResult = await this.postChannelMessage(channelResult.value, text, embed);
    if (!postResult.ok) {
      return Response.json(
        { error: postResult.error },
        { status: postResult.status, headers: corsHeaders() }
      );
    }

    return Response.json(
      { ok: true, message: postResult.message, channel: postResult.channel },
      { headers: corsHeaders() }
    );
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

    const nickChangeResult = await this.requestNickChange(body.nick);
    if (!nickChangeResult.ok) {
      return Response.json({ error: nickChangeResult.error }, { status: nickChangeResult.status, headers: corsHeaders() });
    }
    const confirmedNick = nickChangeResult.nick;
    return Response.json({ ok: true, nick: confirmedNick }, { headers: corsHeaders() });
  }

  private async handleApiConfig(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "invalid JSON" },
        { status: 400, headers: corsHeaders() }
      );
    }

    const configUpdateResult = this.buildPersistedProxyConfigUpdate(this.instanceConfig, body);
    if (!configUpdateResult.ok) {
      return Response.json(
        { error: configUpdateResult.error },
        { status: configUpdateResult.status, headers: corsHeaders() }
      );
    }

    await this.persistProxyConfig(configUpdateResult.config);
    this.applyResolvedProxyConfig(configUpdateResult.config);

    return Response.json({
      ok: true,
      config: {
        nick: this.config?.server.nick ?? null,
        autojoin: this.config?.autojoin ?? [],
      },
    }, { headers: corsHeaders() });
  }

  private async handleWebNick(request: Request, webBase: string): Promise<Response> {
    const formData = await request.formData();
    const nick = (formData.get("nick") as string | null) ?? "";
    const nickChangeResult = await this.requestNickChange(nick);

    if (!nickChangeResult.ok) {
      return new Response(
        this.buildWebChannelListPage(webBase, {
          nick,
          flashMessage: `NICK変更に失敗しました: ${nickChangeResult.error}`,
          flashTone: "danger",
        }),
        {
          status: nickChangeResult.status,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    return new Response(
      this.buildWebChannelListPage(webBase, {
        nick: nickChangeResult.nick,
        flashMessage: `NICKを ${nickChangeResult.nick} に変更しました`,
        flashTone: "info",
      }),
      {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  private buildWebChannelListPage(
    webBase: string,
    options: {
      nick?: string;
      flashMessage?: string;
      flashTone?: "info" | "danger";
      configFormValues?: { nick: string; autojoin: string };
    } = {}
  ): string {
    return buildChannelListPage(
      this.channels,
      options.nick ?? this.nick,
      this.serverName,
      this.serverConn?.connected ?? false,
      webBase,
      Boolean(this.config?.password),
      this.canEditWebSettings(),
      options.flashMessage ?? "",
      options.flashTone ?? "info",
      options.configFormValues ?? this.buildWebPersistedConfigFormValues()
    );
  }

  private buildWebPersistedConfigFormValues(
    config: ProxyInstanceConfig | undefined = this.instanceConfig
  ): { nick: string; autojoin: string } {
    return {
      nick: config?.nick ?? "",
      autojoin: config?.autojoin?.join("\n") ?? "",
    };
  }

  private readWebPersistedConfigFormValues(formData: FormData): { nick: string; autojoin: string } {
    const nickValue = formData.get("nick");
    const autojoinValue = formData.get("autojoin");
    return {
      nick: typeof nickValue === "string" ? nickValue : "",
      autojoin: typeof autojoinValue === "string" ? autojoinValue : "",
    };
  }

  private buildPersistedProxyConfigUpdateFromFormData(
    currentConfig: ProxyInstanceConfig | undefined,
    formData: FormData,
  ):
    | { ok: true; config?: ProxyInstanceConfig; formValues: { nick: string; autojoin: string } }
    | { ok: false; error: string; status: number; formValues: { nick: string; autojoin: string } } {
    const formValues = this.readWebPersistedConfigFormValues(formData);
    const autojoin = formValues.autojoin
      .split(/\r?\n/u)
      .map((channel) => channel.trim())
      .filter(Boolean);
    const configUpdateResult = this.buildPersistedProxyConfigUpdate(currentConfig, {
      nick: formValues.nick,
      autojoin,
    });

    return { ...configUpdateResult, formValues };
  }

  private async handleWebConfig(request: Request, webBase: string): Promise<Response> {
    const formData = await request.formData();
    const configUpdateResult = this.buildPersistedProxyConfigUpdateFromFormData(this.instanceConfig, formData);

    if (!configUpdateResult.ok) {
      return new Response(
        this.buildWebChannelListPage(webBase, {
          flashMessage: `接続デフォルト設定の保存に失敗しました: ${configUpdateResult.error}`,
          flashTone: "danger",
          configFormValues: configUpdateResult.formValues,
        }),
        {
          status: configUpdateResult.status,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    await this.persistProxyConfig(configUpdateResult.config);
    this.applyResolvedProxyConfig(configUpdateResult.config);

    const successMessage = configUpdateResult.config
      ? "接続デフォルト設定を保存しました"
      : "接続デフォルト設定をクリアしました";
    return new Response(
      this.buildWebChannelListPage(webBase, {
        flashMessage: successMessage,
        flashTone: "info",
        configFormValues: this.buildWebPersistedConfigFormValues(configUpdateResult.config),
      }),
      {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  private async requestNickChange(nick: string | undefined): Promise<
    | { ok: true; nick: string }
    | { ok: false; error: string; status: number }
  > {
    const nickResult = validateNickInput(nick);
    if (!nickResult.ok) {
      return { ok: false, error: nickResult.error, status: 400 };
    }
    const requestedNick = nickResult.value;

    if (!this.serverConn?.connected) {
      return { ok: false, error: "not connected to IRC server", status: 503 };
    }

    let pendingNickChange: NonNullable<IrcProxyDO["pendingNickChange"]>;
    const pendingNickChangePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNickChange = null;
        reject(new Error("timeout waiting for server response"));
      }, 5000);
      pendingNickChange = { requestedNick, resolve, reject, timer };
      this.pendingNickChange = pendingNickChange;
    });

    try {
      await this.serverConn.send({
        command: "NICK",
        params: [requestedNick],
      });
    } catch (err) {
      if (this.pendingNickChange === pendingNickChange!) {
        clearTimeout(pendingNickChange!.timer);
        this.pendingNickChange = null;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { ok: false, error: errorMessage, status: 502 };
    }

    try {
      const confirmedNick = await pendingNickChangePromise;
      return { ok: true, nick: confirmedNick };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { ok: false, error: errorMessage, status: 503 };
    }
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
    const channelResult = validateChannelInput(channel);
    if (!channelResult.ok) {
      return Response.json(
        { error: channelResult.error },
        { status: 400, headers: corsHeaders() }
      );
    }
    const logs = this.web.getChannelLogs(channelResult.value);
    if (logs === null) {
      return Response.json(
        { error: "channel not found" },
        { status: 404, headers: corsHeaders() }
      );
    }
    return Response.json({ channel: channelResult.value, messages: logs }, { headers: corsHeaders() });
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

  private getChannelTopic(channel: string): string {
    return this.channelStates.get(channel.toLowerCase())?.topic || this.web.getChannelTopic(channel);
  }

  private renderWebChannelShellPage(channel: string, webBase: string): Response {
    const html = this.web.buildChannelPage(
      channel,
      this.getChannelTopic(channel),
      this.nick,
      webBase,
      Boolean(this.config?.password),
      this.webUiSettings,
      `${webBase}/theme.css`
    );
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  private renderWebChannelMessagesPage(channel: string, webBase: string): Response {
    const revision = this.getChannelRevision(channel);
    const html = this.web.buildChannelMessagesPage(
      channel,
      this.getChannelTopic(channel),
      this.nick,
      this.webUiSettings,
      revision,
      `${webBase}/theme.css`
    );
    return new Response(html, {
      headers: this.buildWebMessagesHeaders(revision),
    });
  }

  private renderWebChannelMessagesFragment(channel: string): Response {
    const revision = this.getChannelRevision(channel);
    const html = this.web.buildChannelMessagesFragment(
      channel,
      this.nick,
      this.webUiSettings
    );
    return new Response(html, {
      headers: this.buildWebMessagesHeaders(revision),
    });
  }

  private renderWebChannelComposerPage(
    channel: string,
    webBase: string,
    messageValue = "",
    flashMessage = "",
    flashTone: "info" | "danger" = "info",
    status = 200,
    shouldReloadMessages = false
  ): Response {
    const html = this.web.buildChannelComposerPage(
      channel,
      webBase,
      messageValue,
      flashMessage,
      flashTone,
      this.webUiSettings,
      shouldReloadMessages,
      `${webBase}/theme.css`
    );
    return new Response(html, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  private async handleWebChannelComposer(
    request: Request,
    channel: string,
    webBase: string
  ): Promise<Response> {
    const formData = await request.formData();
    const messageValue = (formData.get("message") as string | null) ?? "";
    const postResult = await this.postChannelMessage(channel, messageValue);

    if (!postResult.ok) {
      return this.renderWebChannelComposerPage(
        channel,
        webBase,
        messageValue,
        `送信に失敗しました: ${postResult.error}`,
        "danger",
        postResult.status,
        false
      );
    }

    return this.renderWebChannelComposerPage(
      channel,
      webBase,
      "",
      "",
      "info",
      200,
      true
    );
  }

  private async postChannelMessage(
    channel: string | undefined,
    message: string | undefined,
    embed?: ResolvedUrlEmbed,
  ): Promise<
    | { ok: true; message: string; channel: string }
    | { ok: false; error: string; status: number }
  > {
    const channelResult = validateChannelInput(channel);
    if (!channelResult.ok) {
      return { ok: false, error: channelResult.error, status: 400 };
    }

    const messageResult = validateMessageInput(message);
    if (!messageResult.ok) {
      return { ok: false, error: messageResult.error, status: 400 };
    }

    const targetChannel = channelResult.value;
    const trimmedMessage = messageResult.value;
    const serverMessage = escapeUnsupportedIrcText(trimmedMessage, this.config?.server.encoding);

    if (!this.serverConn?.connected) {
      return { ok: false, error: "not connected to IRC server", status: 503 };
    }

    await this.serverConn.send({
      command: "PRIVMSG",
      params: [targetChannel, serverMessage],
    });

    await this.web.recordSelfMessage(targetChannel, this.nick, trimmedMessage, embed);

    this.broadcast({
      prefix: `${this.nick}!proxy@apricot`,
      command: "PRIVMSG",
      params: [targetChannel, trimmedMessage],
    });

    return { ok: true, message: trimmedMessage, channel: targetChannel };
  }

  private async handleClientRegistration(
    ws: WebSocket,
    msg: IrcMessage
  ): Promise<void> {
    const cmd = msg.command.toUpperCase();

    if (cmd === "PASS") {
      // Store password for validation when USER arrives
      const passwordResult = validatePasswordInput(msg.params[0] || "");
      if (!passwordResult.ok) {
        ws.close(1008, "Invalid password");
        return;
      }
      this.pendingPasswords.set(ws, passwordResult.value);
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

  private async ensureProxyConfigInitialized(request?: Request): Promise<void> {
    if (this.hasInitializedProxyConfig) return;

    const requestProxyId = request?.headers.get("X-Proxy-Id");
    const storedProxyId = await this.state.storage.get<string>(proxyIdStorageKey);
    if (!storedProxyId && requestProxyId) {
      await this.state.storage.put(proxyIdStorageKey, requestProxyId);
    }

    this.proxyId = storedProxyId ?? requestProxyId ?? null;

    const storedConfig = await this.readPersistedProxyConfig();
    this.applyResolvedProxyConfig(storedConfig);
    this.hasInitializedProxyConfig = true;
  }

  private applyResolvedProxyConfig(newInstanceConfig?: ProxyInstanceConfig): void {
    this.instanceConfig = newInstanceConfig;
    this.config = resolveProxyConfig(this.envConfig, this.instanceConfig, this.proxyId);

    if (!this.serverConn?.connected) {
      this.nick = this.config?.server.nick ?? "";
    }
  }

  private async readPersistedProxyConfig(): Promise<ProxyInstanceConfig | undefined> {
    const storedConfig = await this.state.storage.get<unknown>(proxyConfigStorageKey);
    return this.normalizeStoredProxyConfig(storedConfig);
  }

  private normalizeStoredProxyConfig(storedConfig: unknown): ProxyInstanceConfig | undefined {
    if (!storedConfig || typeof storedConfig !== "object" || Array.isArray(storedConfig)) {
      return undefined;
    }

    const storedRecord = storedConfig as {
      nick?: unknown;
      autojoin?: unknown;
    };
    const normalizedConfig: ProxyInstanceConfig = {};

    if (typeof storedRecord.nick === "string") {
      const nickResult = validateNickInput(storedRecord.nick);
      if (nickResult.ok) {
        normalizedConfig.nick = nickResult.value;
      }
    }

    if (Array.isArray(storedRecord.autojoin)) {
      const autojoinChannels = storedRecord.autojoin.flatMap((channel) => {
        if (typeof channel !== "string") return [];
        const channelResult = validateChannelInput(channel);
        return channelResult.ok ? [channelResult.value] : [];
      });
      if (autojoinChannels.length > 0) {
        normalizedConfig.autojoin = autojoinChannels;
      }
    }

    return Object.keys(normalizedConfig).length > 0 ? normalizedConfig : undefined;
  }

  private buildPersistedProxyConfigUpdate(
    currentConfig: ProxyInstanceConfig | undefined,
    body: unknown,
  ):
    | { ok: true; config?: ProxyInstanceConfig }
    | { ok: false; error: string; status: number } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, error: "invalid JSON", status: 400 };
    }

    const bodyRecord = body as {
      nick?: unknown;
      autojoin?: unknown;
    };
    const nextConfig: ProxyInstanceConfig = {
      ...(currentConfig?.nick ? { nick: currentConfig.nick } : {}),
      ...(currentConfig?.autojoin ? { autojoin: [...currentConfig.autojoin] } : {}),
    };

    if ("nick" in bodyRecord) {
      const nickResult = this.normalizePersistedNickInput(bodyRecord.nick);
      if (!nickResult.ok) {
        return { ok: false, error: nickResult.error, status: 400 };
      }
      if (nickResult.value) {
        nextConfig.nick = nickResult.value;
      } else {
        delete nextConfig.nick;
      }
    }

    if ("autojoin" in bodyRecord) {
      const autojoinResult = this.normalizePersistedAutojoinInput(bodyRecord.autojoin);
      if (!autojoinResult.ok) {
        return { ok: false, error: autojoinResult.error, status: 400 };
      }
      if (autojoinResult.value) {
        nextConfig.autojoin = autojoinResult.value;
      } else {
        delete nextConfig.autojoin;
      }
    }

    return {
      ok: true,
      config: Object.keys(nextConfig).length > 0 ? nextConfig : undefined,
    };
  }

  private normalizePersistedNickInput(value: unknown):
    | { ok: true; value?: string }
    | { ok: false; error: string } {
    if (value == null || value === "") {
      return { ok: true, value: undefined };
    }
    if (typeof value !== "string") {
      return { ok: false, error: "invalid nick" };
    }

    const nickResult = validateNickInput(value);
    if (!nickResult.ok) {
      return { ok: false, error: nickResult.error };
    }

    return { ok: true, value: nickResult.value };
  }

  private normalizePersistedAutojoinInput(value: unknown):
    | { ok: true; value?: string[] }
    | { ok: false; error: string } {
    if (value == null) {
      return { ok: true, value: undefined };
    }
    if (!Array.isArray(value)) {
      return { ok: false, error: "invalid autojoin" };
    }

    const autojoinChannels: string[] = [];
    for (const channel of value) {
      if (typeof channel !== "string") {
        return { ok: false, error: "invalid autojoin" };
      }

      const channelResult = validateChannelInput(channel);
      if (!channelResult.ok) {
        return { ok: false, error: channelResult.error };
      }
      autojoinChannels.push(channelResult.value);
    }

    return {
      ok: true,
      value: autojoinChannels.length > 0 ? autojoinChannels : undefined,
    };
  }

  private async persistProxyConfig(config?: ProxyInstanceConfig): Promise<void> {
    if (!config) {
      await this.state.storage.delete(proxyConfigStorageKey);
      return;
    }

    await this.state.storage.put(proxyConfigStorageKey, config);
  }

  private async handleStartupAutoConnect(): Promise<void> {
    if (this.hasAttemptedStartupAutoConnect) return;
    this.hasAttemptedStartupAutoConnect = true;

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

  private renderWebThemeCss(): Response {
    return new Response(buildCustomThemeCss(this.webUiSettings), {
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  private buildWebMessagesHeaders(revision: number): HeadersInit {
    return {
      "Content-Type": "text/html; charset=utf-8",
      "X-Apricot-Channel-Revision": String(revision),
      "Cache-Control": "no-store",
    };
  }

  private getChannelRevision(channel: string): number {
    return this.channelRevisions.get(channel.toLowerCase()) ?? 0;
  }

  private handleChannelLogsChanged(channels: string[]): void {
    for (const channel of channels) {
      const revision = this.bumpChannelRevision(channel);
      this.broadcastWebChannelUpdate(channel, revision);
    }
  }

  private bumpChannelRevision(channel: string): number {
    const normalizedChannel = channel.toLowerCase();
    const nextRevision = (this.channelRevisions.get(normalizedChannel) ?? 0) + 1;
    this.channelRevisions.set(normalizedChannel, nextRevision);
    return nextRevision;
  }

  private broadcastWebChannelUpdate(channel: string, revision: number): void {
    const normalizedChannel = channel.toLowerCase();
    const payload: WebChannelUpdateMessage = {
      type: "channel-updated",
      channel,
      revision,
    };
    const serializedPayload = JSON.stringify(payload);
    for (const [ws, subscribedChannel] of this.webUpdateSubscribers) {
      if (subscribedChannel !== normalizedChannel) {
        continue;
      }
      try {
        ws.send(serializedPayload);
      } catch {
        this.webUpdateSubscribers.delete(ws);
      }
    }
  }

  private acceptWebUpdatesSocket(channel: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.webUpdateSubscribers.set(server, channel.toLowerCase());
    this.state.acceptWebSocket(server);
    const payload: WebChannelUpdateMessage = {
      type: "channel-updated",
      channel,
      revision: this.getChannelRevision(channel),
    };
    server.send(JSON.stringify(payload));
    return new Response(null, { status: 101, webSocket: client });
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
    const draftSettings: WebUiSettings = { ...this.webUiSettings };
    const fontFamily = (formData.get("fontFamily") as string | null)?.trim() ?? "";
    if (!fontFamily || fontFamily.length > 200) {
      return {
        settings: { ...draftSettings, fontFamily: fontFamily || draftSettings.fontFamily },
        errorMessage: "Font family は 1〜200 文字で入力してください",
      };
    }
    draftSettings.fontFamily = fontFamily;

    const fontSizeRaw = (formData.get("fontSizePx") as string | null)?.trim() ?? "";
    const fontSizePx = Number.parseInt(fontSizeRaw, 10);
    if (!Number.isInteger(fontSizePx) || fontSizePx < 10 || fontSizePx > 32) {
      return {
        settings: { ...draftSettings },
        errorMessage: "Font size は 10〜32 の整数で入力してください",
      };
    }
    draftSettings.fontSizePx = fontSizePx;

    for (const fieldName of webUiColorFieldNames) {
      const colorValue = (formData.get(fieldName) as string | null)?.trim() ?? "";
      if (!/^#[0-9A-Fa-f]{6}$/.test(colorValue)) {
        return {
          settings: { ...draftSettings },
          errorMessage: `${fieldName} は #RRGGBB 形式で入力してください`,
        };
      }
      draftSettings[fieldName] = colorValue;
    }

    const displayOrder = (formData.get("displayOrder") as string | null)?.trim() ?? "";
    if (!isWebDisplayOrder(displayOrder)) {
      return {
        settings: { ...draftSettings },
        errorMessage: "Display order は asc または desc を指定してください",
      };
    }
    draftSettings.displayOrder = displayOrder;

    const extraCss = (formData.get("extraCss") as string | null) ?? "";
    const customCssResult = sanitizeCustomCss(extraCss);
    if (!customCssResult.ok) {
      return {
        settings: { ...draftSettings },
        errorMessage: customCssResult.error,
      };
    }
    draftSettings.extraCss = customCssResult.value;

    const highlightKeywords = (formData.get("highlightKeywords") as string | null) ?? "";
    if (highlightKeywords.length > 2048) {
      return {
        settings: { ...draftSettings },
        errorMessage: "キーワード強調は 2KB 以下にしてください",
      };
    }
    draftSettings.highlightKeywords = highlightKeywords;

    const dimKeywords = (formData.get("dimKeywords") as string | null) ?? "";
    if (dimKeywords.length > 2048) {
      return {
        settings: { ...draftSettings },
        errorMessage: "キーワードDIMは 2KB 以下にしてください",
      };
    }
    draftSettings.dimKeywords = dimKeywords;
    draftSettings.enableInlineUrlPreview = formData.get("enableInlineUrlPreview") !== null;

    return {
      settings: buildWebUiSettings(draftSettings),
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
    const extraCss = typeof stored.extraCss === "string"
      ? sanitizeStoredCustomCss(stored.extraCss)
      : DEFAULT_WEB_UI_SETTINGS.extraCss;
    const highlightKeywords = typeof stored.highlightKeywords === "string" && stored.highlightKeywords.length <= 2048
      ? stored.highlightKeywords
      : DEFAULT_WEB_UI_SETTINGS.highlightKeywords;
    const dimKeywords = typeof stored.dimKeywords === "string" && stored.dimKeywords.length <= 2048
      ? stored.dimKeywords
      : DEFAULT_WEB_UI_SETTINGS.dimKeywords;
    const enableInlineUrlPreview = typeof stored.enableInlineUrlPreview === "boolean"
      ? stored.enableInlineUrlPreview
      : DEFAULT_WEB_UI_SETTINGS.enableInlineUrlPreview;

    return buildWebUiSettings({
      fontFamily,
      fontSizePx,
      textColor: isValidColor(stored.textColor) ? stored.textColor : LIGHT_WEB_UI_COLOR_PRESET.textColor,
      surfaceColor: isValidColor(stored.surfaceColor) ? stored.surfaceColor : LIGHT_WEB_UI_COLOR_PRESET.surfaceColor,
      surfaceAltColor: isValidColor(stored.surfaceAltColor) ? stored.surfaceAltColor : LIGHT_WEB_UI_COLOR_PRESET.surfaceAltColor,
      accentColor: isValidColor(stored.accentColor) ? stored.accentColor : LIGHT_WEB_UI_COLOR_PRESET.accentColor,
      borderColor: isValidColor(stored.borderColor) ? stored.borderColor : LIGHT_WEB_UI_COLOR_PRESET.borderColor,
      usernameColor: isValidColor(stored.usernameColor) ? stored.usernameColor : LIGHT_WEB_UI_COLOR_PRESET.usernameColor,
      timestampColor: isValidColor(stored.timestampColor) ? stored.timestampColor : LIGHT_WEB_UI_COLOR_PRESET.timestampColor,
      highlightColor: isValidColor(stored.highlightColor) ? stored.highlightColor : LIGHT_WEB_UI_COLOR_PRESET.highlightColor,
      buttonColor: isValidColor(stored.buttonColor) ? stored.buttonColor : LIGHT_WEB_UI_COLOR_PRESET.buttonColor,
      buttonTextColor: isValidColor(stored.buttonTextColor) ? stored.buttonTextColor : LIGHT_WEB_UI_COLOR_PRESET.buttonTextColor,
      selfColor: isValidColor(stored.selfColor) ? stored.selfColor : LIGHT_WEB_UI_COLOR_PRESET.selfColor,
      mutedTextColor: isValidColor(stored.mutedTextColor) ? stored.mutedTextColor : LIGHT_WEB_UI_COLOR_PRESET.mutedTextColor,
      keywordColor: isValidColor(stored.keywordColor) ? stored.keywordColor : LIGHT_WEB_UI_COLOR_PRESET.keywordColor,
      displayOrder,
      extraCss,
      highlightKeywords,
      dimKeywords,
      enableInlineUrlPreview,
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
    const webBase = actionUrl.replace(/\/login\/?$/, "");
    const errorHtml = errorMessage
      ? `<div class="admin-message admin-message--danger" role="alert"><strong>ログインに失敗しました。</strong><span>${errorMessage}</span></div>`
      : "";
    const webAppHeadHtml = buildWebAppHead(webBase, "#f7f8f9");

    const html = LOGIN_TEMPLATE
      .replace("{{CSS}}", buildAdminCss())
      .replace("{{WEB_APP_HEAD}}", webAppHeadHtml)
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

  private renderWebManifest(webBase: string): Response {
    const manifest = {
      name: "apricot",
      short_name: "apricot",
      start_url: `${webBase}/`,
      scope: `${webBase}/`,
      display: "standalone",
      background_color: "#f7f8f9",
      theme_color: this.webUiSettings.surfaceColor,
      icons: [
        {
          src: `${webBase}/assets/app-icon.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    };

    return new Response(JSON.stringify(manifest), {
      headers: {
        "Content-Type": "application/manifest+json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }
}

function buildBrowserRenderingConfig(env: Env): BrowserRenderingConfig | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = env.CLOUDFLARE_BROWSER_RENDERING_API_TOKEN?.trim();
  if (!accountId || !apiToken) {
    return undefined;
  }

  return {
    accountId,
    apiToken,
  };
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
