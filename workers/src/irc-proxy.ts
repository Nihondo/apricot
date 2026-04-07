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
  resolveXEmbedTheme,
  type PersistedWebLogs,
  type WebUiSettings,
} from "./modules/web";
import {
  type BrowserRenderingConfig,
  resolveMessageEmbed,
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
import APRICOT_APP_ICON_PNG from "./assets/apricot_app_icon.png";
import APRICOT_LOGO_PNG from "./assets/apricot_logo.png";
import LOGIN_TEMPLATE from "./templates/login.html";
import {
  handleApiConfig,
  handleApiDisconnect,
  handleApiJoin,
  handleApiLeave,
  handleApiLogs,
  handleApiNick,
  handleApiPost,
} from "./irc-proxy/api-handlers";
import {
  corsHeaders,
  jsonOk,
  methodNotAllowed,
  notFound,
  redirectResponse,
  unauthorized,
} from "./irc-proxy/response";
import { isWebAuthenticated, redirectToWebLogin } from "./irc-proxy/web-auth";
import { normalizeStoredWebUiSettings } from "./irc-proxy/web-settings";
import {
  handleWebChannelComposer,
  handleWebConfig,
  handleWebJoin,
  handleWebLeave,
  handleWebLogin,
  handleWebLogout,
  handleWebNick,
  handleWebSettings,
} from "./irc-proxy/web-handlers";

const proxyConfigStorageKey = "proxy:config:v1";
const proxyIdStorageKey = "proxy:id";
const webLogsStorageKey = "web:logs:v1";
const webUiSettingsStorageKey = "web:ui-settings:v1";
const nickErrorCodes = new Set(["431", "432", "433", "436", "437", "438", "447", "484", "485"]);
const registrationFailureCodes = new Set(["431", "432", "433", "436", "437", "438", "447", "451", "462", "464", "465", "484", "485"]);
type WebChannelUpdateMessage = {
  type: "channel-updated";
  channel: string;
  sequence: number;
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

function parseIntegerEnv(value: string | undefined, fallbackValue: number): number {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function parseRatioEnv(value: string | undefined, fallbackValue: number): number {
  const parsedValue = Number.parseFloat(value ?? "");
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallbackValue;
}

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

  /** Web module instance (holds per-DO message buffers) */
  private readonly web: ReturnType<typeof createWebModule>;
  private webUiSettings: WebUiSettings = buildWebUiSettings();

  /** Keepalive alarm interval in ms */
  private keepaliveMs: number;
  private readonly connectTimeoutMs: number;
  private readonly registrationTimeoutMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectJitterRatio: number;
  private readonly idlePingIntervalMs: number;
  private readonly pingTimeoutMs: number;
  private hasInitializedProxyConfig = false;
  private hasAttemptedStartupAutoConnect = false;
  private connectPromise: Promise<void> | null = null;
  private suppressAutoReconnectOnClose = false;
  private connectionGeneration = 0;
  private connectedGeneration = 0;
  private reconnectAttempt = 0;
  private lastServerActivityAt = 0;
  private pendingPingToken: string | null = null;
  private pendingPingStartedAt = 0;
  private pendingPingDeadlineAt = 0;
  private pendingRegistration: {
    generation: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

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
    this.connectTimeoutMs = parseIntegerEnv(env.IRC_CONNECT_TIMEOUT_MS, 10_000);
    this.registrationTimeoutMs = parseIntegerEnv(env.IRC_REGISTRATION_TIMEOUT_MS, 20_000);
    this.reconnectBaseDelayMs = parseIntegerEnv(env.IRC_RECONNECT_BASE_DELAY_MS, 5_000);
    this.reconnectMaxDelayMs = parseIntegerEnv(env.IRC_RECONNECT_MAX_DELAY_MS, 60_000);
    this.reconnectJitterRatio = parseRatioEnv(env.IRC_RECONNECT_JITTER_RATIO, 0.2);
    this.idlePingIntervalMs = parseIntegerEnv(env.IRC_IDLE_PING_INTERVAL_MS, 240_000);
    this.pingTimeoutMs = parseIntegerEnv(env.IRC_PING_TIMEOUT_MS, 90_000);
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

    if (isProtectedWebAssetRequest && !await isWebAuthenticated(request, proxyPrefix, this.config?.password)) {
      return unauthorized();
    }

    if (isProtectedWebRequest && !webUpdatesMatch && !await isWebAuthenticated(request, proxyPrefix, this.config?.password)) {
      return redirectToWebLogin(webBase);
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
      return jsonOk({
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
      return handleApiJoin(request, this.serverConn);
    }

    // POST /api/leave — leave a channel
    if (request.method === "POST" && url.pathname === "/api/leave") {
      return handleApiLeave(request, this.serverConn);
    }

    // POST /api/post — programmatic message posting
    if (request.method === "POST" && url.pathname === "/api/post") {
      return handleApiPost(request, {
        browserRenderingConfig: this.browserRenderingConfig,
        config: this.config,
        getResolvedConfig: () => this.config,
        instanceConfig: this.instanceConfig,
        serverConn: this.serverConn,
        state: this.state,
        web: this.web,
        webUiSettings: this.webUiSettings,
        applyResolvedProxyConfig: this.applyResolvedProxyConfig.bind(this),
        buildPersistedProxyConfigUpdate: this.buildPersistedProxyConfigUpdate.bind(this),
        persistProxyConfig: this.persistProxyConfig.bind(this),
        postChannelMessage: this.postChannelMessage.bind(this),
        requestNickChange: this.requestNickChange.bind(this),
        resetConnectionRecoveryState: this.resetConnectionRecoveryState.bind(this),
        setSuppressAutoReconnectOnClose: (value) => {
          this.suppressAutoReconnectOnClose = value;
        },
      });
    }

    // POST /api/nick — request a nick change
    if (request.method === "POST" && url.pathname === "/api/nick") {
      return handleApiNick(request, this.requestNickChange.bind(this));
    }

    // PUT /api/config — persist per-proxy default config
    if (request.method === "PUT" && url.pathname === "/api/config") {
      return handleApiConfig(request, {
        browserRenderingConfig: this.browserRenderingConfig,
        config: this.config,
        getResolvedConfig: () => this.config,
        instanceConfig: this.instanceConfig,
        serverConn: this.serverConn,
        state: this.state,
        web: this.web,
        webUiSettings: this.webUiSettings,
        applyResolvedProxyConfig: this.applyResolvedProxyConfig.bind(this),
        buildPersistedProxyConfigUpdate: this.buildPersistedProxyConfigUpdate.bind(this),
        persistProxyConfig: this.persistProxyConfig.bind(this),
        postChannelMessage: this.postChannelMessage.bind(this),
        requestNickChange: this.requestNickChange.bind(this),
        resetConnectionRecoveryState: this.resetConnectionRecoveryState.bind(this),
        setSuppressAutoReconnectOnClose: (value) => {
          this.suppressAutoReconnectOnClose = value;
        },
      });
    }

    // POST /api/disconnect — disconnect from IRC server
    if (request.method === "POST" && url.pathname === "/api/disconnect") {
      return handleApiDisconnect({
        browserRenderingConfig: this.browserRenderingConfig,
        config: this.config,
        getResolvedConfig: () => this.config,
        instanceConfig: this.instanceConfig,
        serverConn: this.serverConn,
        state: this.state,
        web: this.web,
        webUiSettings: this.webUiSettings,
        applyResolvedProxyConfig: this.applyResolvedProxyConfig.bind(this),
        buildPersistedProxyConfigUpdate: this.buildPersistedProxyConfigUpdate.bind(this),
        persistProxyConfig: this.persistProxyConfig.bind(this),
        postChannelMessage: this.postChannelMessage.bind(this),
        requestNickChange: this.requestNickChange.bind(this),
        resetConnectionRecoveryState: this.resetConnectionRecoveryState.bind(this),
        setSuppressAutoReconnectOnClose: (value) => {
          this.suppressAutoReconnectOnClose = value;
        },
      });
    }

    // GET /api/logs/:channel — retrieve buffered messages for a channel
    const logsMatch = url.pathname.match(/^\/api\/logs\/(.+)$/);
    if (request.method === "GET" && logsMatch) {
      return handleApiLogs(decodeURIComponent(logsMatch[1]), this.web);
    }

    // --- Web interface routes ---

    // GET /web/login — login form for password-protected web UI
    if (request.method === "GET" && isWebLoginPath) {
      if (await isWebAuthenticated(request, proxyPrefix, this.config?.password)) {
        return redirectResponse(`${webBase}/`);
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
      return handleWebLogin(request, proxyPrefix, webBase, {
        configPassword: this.config?.password,
        renderWebLoginPage: this.renderWebLoginPage.bind(this),
      });
    }

    // POST /web/logout — clear session cookie
    if (request.method === "POST" && isWebLogoutPath) {
      return handleWebLogout(request, proxyPrefix, webBase);
    }

    if (isWebLoginPath || isWebLogoutPath) {
      return methodNotAllowed();
    }

    if (isWebSettingsPath && !this.canEditWebSettings()) {
      return notFound();
    }

    if (request.method === "GET" && isWebSettingsPath) {
      return this.renderWebSettingsPage(webBase);
    }

    if (request.method === "POST" && isWebSettingsPath) {
      return handleWebSettings(request, webBase, {
        currentSettings: this.webUiSettings,
        persistWebUiSettings: this.persistWebUiSettings.bind(this),
        renderWebSettingsPage: this.renderWebSettingsPage.bind(this),
      });
    }

    if (isWebSettingsPath) {
      return methodNotAllowed();
    }

    if (request.method === "POST" && isWebConfigPath) {
      return handleWebConfig(request, webBase, {
        instanceConfig: this.instanceConfig,
        buildPersistedProxyConfigUpdate: this.buildPersistedProxyConfigUpdate.bind(this),
        persistProxyConfig: this.persistProxyConfig.bind(this),
        applyResolvedProxyConfig: this.applyResolvedProxyConfig.bind(this),
        buildWebPersistedConfigFormValues: this.buildWebPersistedConfigFormValues.bind(this),
        buildWebChannelListPage: this.buildWebChannelListPage.bind(this),
      });
    }

    if (isWebConfigPath) {
      return methodNotAllowed();
    }

    if (url.pathname === "/web/display-order" || url.pathname === "/web/display-order/") {
      return notFound();
    }

    // POST /web/join — join a channel from web UI
    if (request.method === "POST" && (url.pathname === "/web/join" || url.pathname === "/web/join/")) {
      return handleWebJoin(request, webBase, this.buildWebChannelListPage.bind(this), this.serverConn);
    }

    // POST /web/leave — leave a channel from web UI
    if (request.method === "POST" && (url.pathname === "/web/leave" || url.pathname === "/web/leave/")) {
      return handleWebLeave(request, webBase, this.buildWebChannelListPage.bind(this), this.serverConn);
    }

    // POST /web/nick — change nick from web UI
    if (request.method === "POST" && (url.pathname === "/web/nick" || url.pathname === "/web/nick/")) {
      return handleWebNick(request, webBase, {
        buildWebChannelListPage: this.buildWebChannelListPage.bind(this),
        requestNickChange: this.requestNickChange.bind(this),
      });
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
        return methodNotAllowed();
      }
      return this.renderWebChannelMessagesFragment(
        decodeURIComponent(webMessagesFragmentMatch[1]),
        Number(url.searchParams.get("since") || "0")
      );
    }

    const webMessagesMatch = url.pathname.match(/^\/web\/(.+)\/messages\/?$/);
    if (webMessagesMatch) {
      if (request.method !== "GET") {
        return methodNotAllowed();
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
        return handleWebChannelComposer(request, channel, webBase, {
          postChannelMessage: this.postChannelMessage.bind(this),
          renderWebChannelComposerPage: this.renderWebChannelComposerPage.bind(this),
        });
      }
      return methodNotAllowed();
    }

    // GET /web/:channel
    const webMatch = url.pathname.match(/^\/web\/(.+)\/?$/);
    if (webMatch) {
      if (request.method !== "GET") {
        return methodNotAllowed();
      }
      return this.renderWebChannelShellPage(decodeURIComponent(webMatch[1]), webBase);
    }

    return notFound();
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
      await this.performConnectionHealthCheck();
      if (this.serverConn?.connected) {
        await this.scheduleKeepaliveAlarm();
      }
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
    const channelSequence = this.web.getChannelLatestSequence(channel);
    const html = this.web.buildChannelMessagesPage(
      channel,
      this.getChannelTopic(channel),
      this.nick,
      this.webUiSettings,
      channelSequence,
      `${webBase}/theme.css`
    );
    return new Response(html, {
      headers: this.buildWebMessagesHeaders(channelSequence),
    });
  }

  private renderWebChannelMessagesFragment(channel: string, sinceSequence: number): Response {
    const fragment = this.web.buildChannelMessagesFragment(
      channel,
      this.nick,
      this.webUiSettings,
      Number.isFinite(sinceSequence) ? Math.trunc(sinceSequence) : 0
    );
    return new Response(fragment.html, {
      headers: this.buildWebMessagesHeaders(fragment.latestSequence, {
        startSequence: fragment.startSequence,
        mode: fragment.mode,
      }),
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

    // enableRemoteUrlPreview が有効で embed が未解決の場合に自動解決する。
    // 接続チェック後に実行することで、未接続時は外部 fetch を行わず即座に 503 を返す。
    // 呼び出し側（handleApiPost の URL モードなど）が既に embed を渡している場合は二重解決しない。
    // Note: IRC サーバが自分の発言をエコーバックする構成では ss_privmsg の受信側でも
    //       resolveMessageEmbed が走るため、同じ URL への fetch が二重になる場合がある。
    if (embed === undefined && this.config?.enableRemoteUrlPreview) {
      try {
        embed = await resolveMessageEmbed(trimmedMessage, {
          xTheme: resolveXEmbedTheme(this.webUiSettings.surfaceColor),
        });
      } catch {
        embed = undefined;
      }
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
    let lastError: Error | null = null;

    for (const port of ports) {
      const generation = ++this.connectionGeneration;
      const cfg = { ...this.config.server, port };
      const registrationPromise = this.createRegistrationPromise(generation);

      this.serverConn = new IrcServerConnection(
        cfg,
        // onMessage — handle messages from IRC server
        async (msg) => {
          await this.handleServerMessage(msg, generation);
        },
        // onClose
        async () => {
          await this.handleServerClose(generation);
        },
        {
          connectTimeoutMs: this.connectTimeoutMs,
        }
      );
      this.resetConnectionHealthState();

      try {
        console.log(`IRC: connect attempt generation=${generation} port=${port}`);
        await this.serverConn.connect();
        await registrationPromise;
        return; // Success
      } catch (err) {
        console.error(`IRC: failed to connect on port ${port}`, err);
        lastError = err instanceof Error ? err : new Error(String(err));
        this.rejectPendingRegistration(generation, lastError);
        await this.serverConn?.close().catch(() => undefined);
        this.serverConn = null;
      }
    }

    throw lastError ?? new Error("failed to connect to IRC server");
  }

  private async handleServerMessage(
    msg: IrcMessage,
    generation: number = this.connectionGeneration,
  ): Promise<void> {
    if (generation !== this.connectionGeneration) {
      console.log(`IRC: ignoring stale message for generation=${generation}`);
      return;
    }

    const cmd = msg.command;
    this.lastServerActivityAt = Date.now();

    if (cmd === "PONG") {
      const pongToken = msg.params.at(-1) ?? msg.params[0] ?? "";
      if (this.pendingPingToken && pongToken === this.pendingPingToken) {
        console.log(`IRC: received health-check pong token=${pongToken}`);
        this.clearPendingPingState();
      }
    }

    // Handle 001 RPL_WELCOME — server registration complete
    if (cmd === "001") {
      this.serverConn?.markConnected();
      this.connectedGeneration = generation;
      this.resolvePendingRegistration(generation);
      this.reconnectAttempt = 0;
      this.clearPendingPingState();
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

    if ((cmd === "ERROR" || registrationFailureCodes.has(cmd)) && this.pendingRegistration?.generation === generation) {
      const errorMessage = msg.params.at(-1) || "registration failed";
      this.rejectPendingRegistration(generation, new Error(errorMessage));
      await this.serverConn?.close();
      return;
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
    this.reconnectAttempt += 1;
    const reconnectDelayMs = this.calculateReconnectDelayMs(this.reconnectAttempt);
    console.log(`IRC: scheduling reconnect attempt=${this.reconnectAttempt} delayMs=${reconnectDelayMs}`);
    await this.state.storage.setAlarm(Date.now() + reconnectDelayMs);
  }

  private consumeAutoReconnectOnClose(): boolean {
    const shouldReconnect = Boolean(this.config?.autoReconnectOnDisconnect)
      && !this.suppressAutoReconnectOnClose;
    this.suppressAutoReconnectOnClose = false;
    return shouldReconnect;
  }

  /**
   * Clears pending ping state and resets idle activity tracking.
   */
  private resetConnectionHealthState(lastActivityAt = 0): void {
    this.lastServerActivityAt = lastActivityAt;
    this.clearPendingPingState();
  }

  /**
   * Clears the in-flight active ping request, if any.
   */
  private clearPendingPingState(): void {
    this.pendingPingToken = null;
    this.pendingPingStartedAt = 0;
    this.pendingPingDeadlineAt = 0;
  }

  /**
   * Resets reconnect counters and health-check state, used for manual disconnects.
   */
  private resetConnectionRecoveryState(): void {
    this.reconnectAttempt = 0;
    this.resetConnectionHealthState();
    this.rejectPendingRegistration(this.connectionGeneration, new Error("connection recovery state reset"));
  }

  /**
   * Creates a registration wait promise for the given connection generation.
   */
  private createRegistrationPromise(generation: number): Promise<void> {
    this.rejectPendingRegistration(generation - 1, new Error("superseded by a new connection attempt"));

    const registrationPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPendingRegistration(
          generation,
          new Error(`registration timed out after ${this.registrationTimeoutMs}ms`),
        );
      }, this.registrationTimeoutMs);

      this.pendingRegistration = {
        generation,
        resolve,
        reject,
        timer,
      };
    });

    void registrationPromise.catch(() => undefined);
    return registrationPromise;
  }

  /**
   * Marks the pending registration as successful for the current generation.
   */
  private resolvePendingRegistration(generation: number): void {
    if (!this.pendingRegistration || this.pendingRegistration.generation !== generation) {
      return;
    }

    clearTimeout(this.pendingRegistration.timer);
    this.pendingRegistration.resolve();
    this.pendingRegistration = null;
  }

  /**
   * Rejects the pending registration wait for the current generation.
   */
  private rejectPendingRegistration(generation: number, error: Error): void {
    if (!this.pendingRegistration || this.pendingRegistration.generation !== generation) {
      return;
    }

    clearTimeout(this.pendingRegistration.timer);
    this.pendingRegistration.reject(error);
    this.pendingRegistration = null;
  }

  /**
   * Handles socket close for the active connection generation only.
   */
  private async handleServerClose(generation: number): Promise<void> {
    if (generation !== this.connectionGeneration) {
      console.log(`IRC: stale close ignored generation=${generation} current=${this.connectionGeneration}`);
      return;
    }

    const wasConnected = this.connectedGeneration === generation;
    if (wasConnected) {
      this.connectedGeneration = 0;
    }

    this.rejectPendingRegistration(generation, new Error("connection closed before registration completed"));
    this.resetConnectionHealthState();
    this.serverConn = null;

    await this.state.storage.deleteAlarm();

    if (!wasConnected) {
      return;
    }

    const ctx = this.makeContext(0);
    await this.modules.dispatchLifecycle("onServerClose", ctx);
    await this.persistCurrentWebLogs();

    this.broadcast({
      prefix: "apricot",
      command: "NOTICE",
      params: ["*", "Disconnected from IRC server"],
    });

    if (this.consumeAutoReconnectOnClose()) {
      await this.scheduleReconnectAlarm();
    }
  }

  /**
   * Performs idle-time health checking by sending IRC PING and watching for activity.
   */
  private async performConnectionHealthCheck(): Promise<void> {
    const serverConn = this.serverConn;
    if (!serverConn?.connected) {
      return;
    }

    const now = Date.now();
    if (this.pendingPingToken) {
      if (this.lastServerActivityAt > this.pendingPingStartedAt) {
        console.log("IRC: health check recovered from non-PONG activity");
        this.clearPendingPingState();
        return;
      }

      if (now < this.pendingPingDeadlineAt) {
        return;
      }

      console.error(`IRC: ping timeout token=${this.pendingPingToken}`);
      this.clearPendingPingState();
      await serverConn.close();
      return;
    }

    if (!this.lastServerActivityAt) {
      this.lastServerActivityAt = now;
      return;
    }

    if (now - this.lastServerActivityAt < this.idlePingIntervalMs) {
      return;
    }

    const pingToken = `apricot:${now}`;
    this.pendingPingToken = pingToken;
    this.pendingPingStartedAt = now;
    this.pendingPingDeadlineAt = now + this.pingTimeoutMs;
    console.log(`IRC: sending health-check ping token=${pingToken}`);

    try {
      await serverConn.send({ command: "PING", params: [pingToken] });
    } catch (error) {
      console.error("IRC: failed to send health-check ping", error);
      this.clearPendingPingState();
    }
  }

  /**
   * Computes the next reconnect delay with exponential backoff and jitter.
   */
  private calculateReconnectDelayMs(attempt: number): number {
    const exponentialDelayMs = Math.min(
      this.reconnectBaseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
      this.reconnectMaxDelayMs,
    );
    const jitterScale = this.reconnectJitterRatio * ((Math.random() * 2) - 1);
    const jitteredDelayMs = exponentialDelayMs * (1 + jitterScale);
    return Math.max(0, Math.round(jitteredDelayMs));
  }

  private async loadPersistedWebLogs(): Promise<void> {
    const logs = await this.state.storage.get<PersistedWebLogs>(webLogsStorageKey);
    this.web.hydrateLogs(logs ?? null);
  }

  private async loadPersistedWebUiSettings(): Promise<void> {
    const stored = await this.state.storage.get<Partial<WebUiSettings>>(webUiSettingsStorageKey);
    this.webUiSettings = normalizeStoredWebUiSettings(stored);
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

  private buildWebMessagesHeaders(
    channelSequence: number,
    fragment?: { startSequence: number; mode: "full" | "delta" }
  ): HeadersInit {
    const headers: HeadersInit = {
      "Content-Type": "text/html; charset=utf-8",
      "X-Apricot-Channel-Sequence": String(channelSequence),
      "Cache-Control": "no-store",
    };
    if (fragment) {
      return {
        ...headers,
        "X-Apricot-Fragment-Start-Sequence": String(fragment.startSequence),
        "X-Apricot-Fragment-Mode": fragment.mode,
      };
    }
    return headers;
  }

  private handleChannelLogsChanged(channels: string[]): void {
    for (const channel of channels) {
      this.broadcastWebChannelUpdate(channel, this.web.getChannelLatestSequence(channel));
    }
  }

  private broadcastWebChannelUpdate(channel: string, channelSequence: number): void {
    const normalizedChannel = channel.toLowerCase();
    const payload: WebChannelUpdateMessage = {
      type: "channel-updated",
      channel,
      sequence: channelSequence,
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
      sequence: this.web.getChannelLatestSequence(channel),
    };
    server.send(JSON.stringify(payload));
    return new Response(null, { status: 101, webSocket: client });
  }

  private canEditWebSettings(): boolean {
    return Boolean(this.config?.password);
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
