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
