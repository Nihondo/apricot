import type { IrcServerConfig } from "./irc-connection";

/**
 * Runtime configuration for a single proxy instance.
 */
export interface ProxyConfig {
  server: IrcServerConfig;
  ports: number[];
  password?: string;
  autojoin?: string[];
  autoConnectOnStartup: boolean;
  autoReconnectOnDisconnect: boolean;
}

/**
 * Builds proxy configuration from environment variables.
 */
export function buildProxyConfigFromEnv(env: Env): ProxyConfig | null {
  if (!env.IRC_HOST) return null;

  const ports = parsePorts(env.IRC_PORT || "6667");
  return {
    server: {
      host: env.IRC_HOST,
      port: ports[0],
      nick: env.IRC_NICK || "apricot",
      user: env.IRC_USER || "apricot",
      realname: env.IRC_REALNAME || "apricot IRC Proxy",
      tls: parseBooleanEnv(env.IRC_TLS),
      password: env.IRC_PASSWORD,
      encoding: env.IRC_ENCODING,
    },
    ports,
    password: env.CLIENT_PASSWORD,
    autojoin: splitCsvValue(env.IRC_AUTOJOIN),
    autoConnectOnStartup: parseBooleanEnv(env.IRC_AUTO_CONNECT_ON_STARTUP),
    autoReconnectOnDisconnect: parseBooleanEnv(env.IRC_AUTO_RECONNECT_ON_DISCONNECT),
  };
}

/**
 * Parses a boolean-like environment variable.
 */
export function parseBooleanEnv(value?: string): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Parses port expressions like `6667`, `6660-6669`, or `6660,6667,6697`.
 */
export function parsePorts(raw: string): number[] {
  const ports: number[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let port = start; port <= end; port += 1) {
        ports.push(port);
      }
      continue;
    }

    const port = parseInt(trimmed, 10);
    if (!Number.isNaN(port)) {
      ports.push(port);
    }
  }
  return ports.length > 0 ? ports : [6667];
}

function splitCsvValue(value?: string): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}
