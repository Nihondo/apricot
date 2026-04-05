import type { IrcServerConfig } from "./irc-connection";

const ircNickBodyPattern = /[^A-Za-z0-9_\-[\]\\^{}|]/g;
const ircNickHeadPattern = /^[A-Za-z_\-[\]\\^{}|]/;
const maxDefaultNickLength = 9;

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
  enableRemoteUrlPreview: boolean;
}

/**
 * Persisted per-proxy overrides stored in Durable Object storage.
 */
export interface ProxyInstanceConfig {
  nick?: string;
  autojoin?: string[];
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
    enableRemoteUrlPreview: parseBooleanEnv(env.ENABLE_REMOTE_URL_PREVIEW),
  };
}

/**
 * Resolves the effective proxy configuration from shared env and instance overrides.
 */
export function resolveProxyConfig(
  baseConfig: ProxyConfig | null,
  instanceConfig?: ProxyInstanceConfig,
  proxyId?: string | null,
): ProxyConfig | null {
  if (!baseConfig) return null;

  const resolvedNick = resolveNickValue(
    instanceConfig?.nick,
    sanitizeNick(proxyId),
    baseConfig.server.nick,
  );
  const resolvedAutojoin = resolveAutojoinValue(instanceConfig?.autojoin, baseConfig.autojoin);

  return {
    ...baseConfig,
    server: {
      ...baseConfig.server,
      nick: resolvedNick,
    },
    autojoin: resolvedAutojoin,
  };
}

/**
 * Converts a proxy id into a safe fallback IRC nick.
 */
export function sanitizeNick(value?: string | null): string | undefined {
  const trimmedValue = value?.trim();
  if (!trimmedValue) return undefined;

  let sanitizedValue = trimmedValue.replace(ircNickBodyPattern, "_");
  if (!sanitizedValue) return undefined;

  if (!ircNickHeadPattern.test(sanitizedValue)) {
    sanitizedValue = `a${sanitizedValue}`;
  }

  return sanitizedValue.slice(0, maxDefaultNickLength);
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

function resolveNickValue(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmedValue = candidate?.trim();
    if (trimmedValue) {
      return trimmedValue;
    }
  }
  return "apricot";
}

function resolveAutojoinValue(
  instanceAutojoin?: string[],
  fallbackAutojoin?: string[],
): string[] | undefined {
  if (instanceAutojoin) {
    return instanceAutojoin.length > 0 ? [...instanceAutojoin] : undefined;
  }

  return fallbackAutojoin ? [...fallbackAutojoin] : undefined;
}
