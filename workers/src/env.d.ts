interface Env {
  IRC_PROXY: DurableObjectNamespace;
  // Auth
  API_KEY: string;
  // IRC server config
  IRC_HOST: string;
  IRC_PORT: string;
  IRC_NICK: string;
  IRC_USER: string;
  IRC_REALNAME: string;
  IRC_TLS: string;
  IRC_PASSWORD?: string;
  // Client config
  CLIENT_PASSWORD?: string;
  IRC_AUTO_CONNECT_ON_STARTUP?: string;
  IRC_AUTO_RECONNECT_ON_DISCONNECT?: string;
  IRC_CONNECT_TIMEOUT_MS?: string;
  IRC_REGISTRATION_TIMEOUT_MS?: string;
  IRC_RECONNECT_BASE_DELAY_MS?: string;
  IRC_RECONNECT_MAX_DELAY_MS?: string;
  IRC_RECONNECT_JITTER_RATIO?: string;
  IRC_IDLE_PING_INTERVAL_MS?: string;
  IRC_PING_TIMEOUT_MS?: string;
  ENABLE_REMOTE_URL_PREVIEW?: string;
  CLOUDFLARE_BROWSER_RENDERING_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  // Channels
  IRC_AUTOJOIN: string;
  // DO keepalive
  KEEPALIVE_INTERVAL: string;
  // Timezone offset for web UI (hours, e.g. 9 for JST)
  TIMEZONE_OFFSET?: string;
  // Max lines to keep in web log buffer per channel
  WEB_LOG_MAX_LINES?: string;
  // IRC server character encoding (e.g. "iso-2022-jp", "utf-8")
  IRC_ENCODING?: string;
}
