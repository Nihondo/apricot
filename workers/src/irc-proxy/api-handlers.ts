/**
 * API エンドポイント向けハンドラ群。
 */

import type { DurableObjectState } from "@cloudflare/workers-types";
import { validateChannelInput } from "../input-validation";
import { extractUrlMetadata, resolveUrlEmbed, type BrowserRenderingConfig, type ResolvedUrlEmbed } from "../modules/url-metadata";
import { resolveXEmbedTheme, type PersistedWebLogs, type WebUiSettings } from "../modules/web";
import type { ProxyConfig, ProxyInstanceConfig } from "../proxy-config";
import { jsonError, jsonOk } from "./response";
import { parseJsonBody, requireConnected } from "./request-guards";

type NickChangeResult =
  | { ok: true; nick: string }
  | { ok: false; error: string; status: number };
type PostMessageResult =
  | { ok: true; message: string; channel: string }
  | { ok: false; error: string; status: number };
type PersistedProxyConfigUpdate =
  | { ok: true; config?: ProxyInstanceConfig }
  | { ok: false; error: string; status: number };

interface ApiHandlerContext {
  browserRenderingConfig?: BrowserRenderingConfig;
  config: ProxyConfig | null;
  getResolvedConfig(): ProxyConfig | null;
  instanceConfig?: ProxyInstanceConfig;
  serverConn: {
    connected: boolean;
    send(message: { command: string; params: string[] }): Promise<void>;
    close(): Promise<void>;
  } | null;
  state: DurableObjectState;
  web: {
    getChannelLogs(channel: string): PersistedWebLogs[string] | null;
  };
  webUiSettings: WebUiSettings;
  applyResolvedProxyConfig(config?: ProxyInstanceConfig): void;
  buildPersistedProxyConfigUpdate(
    currentConfig: ProxyInstanceConfig | undefined,
    body: unknown,
  ): PersistedProxyConfigUpdate;
  persistProxyConfig(config?: ProxyInstanceConfig): Promise<void>;
  postChannelMessage(
    channel: string | undefined,
    message: string | undefined,
    embed?: ResolvedUrlEmbed,
  ): Promise<PostMessageResult>;
  requestNickChange(nick: string | undefined): Promise<NickChangeResult>;
  resetConnectionRecoveryState(): void;
  setSuppressAutoReconnectOnClose(value: boolean): void;
}

/**
 * API の JOIN 要求を処理する。
 */
export async function handleApiJoin(request: Request, serverConn: ApiHandlerContext["serverConn"]): Promise<Response> {
  const bodyResult = await parseJsonBody<{ channel?: string }>(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const channelResult = validateChannelInput(bodyResult.value.channel);
  if (!channelResult.ok) {
    return jsonError(channelResult.error, 400);
  }
  const connectedError = requireConnected(serverConn as any);
  if (connectedError) {
    return connectedError;
  }
  await serverConn!.send({ command: "JOIN", params: [channelResult.value] });
  return jsonOk({ ok: true, channel: channelResult.value });
}

/**
 * API の PART 要求を処理する。
 */
export async function handleApiLeave(request: Request, serverConn: ApiHandlerContext["serverConn"]): Promise<Response> {
  const bodyResult = await parseJsonBody<{ channel?: string }>(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const channelResult = validateChannelInput(bodyResult.value.channel);
  if (!channelResult.ok) {
    return jsonError(channelResult.error, 400);
  }
  const connectedError = requireConnected(serverConn as any);
  if (connectedError) {
    return connectedError;
  }
  await serverConn!.send({ command: "PART", params: [channelResult.value] });
  return jsonOk({ ok: true, channel: channelResult.value });
}

/**
 * API のメッセージ送信要求を処理する。
 */
export async function handleApiPost(request: Request, context: ApiHandlerContext): Promise<Response> {
  const bodyResult = await parseJsonBody<{ channel?: string; message?: string; url?: string }>(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const channelResult = validateChannelInput(bodyResult.value.channel);
  if (!channelResult.ok) {
    return jsonError(channelResult.error, 400);
  }

  let text = bodyResult.value.message || "";
  let embed: ResolvedUrlEmbed | undefined;
  if (!text && bodyResult.value.url) {
    try {
      embed = await resolveUrlEmbed(bodyResult.value.url, {
        xTheme: resolveXEmbedTheme(context.webUiSettings.surfaceColor),
      });
    } catch {
      embed = undefined;
    }

    try {
      text = await extractUrlMetadata(bodyResult.value.url, {
        browserRendering: context.browserRenderingConfig,
      });
    } catch {
      text = bodyResult.value.url;
    }
  }

  if (!text) {
    return jsonError("missing message or url", 400);
  }

  const connectedError = requireConnected(context.serverConn as any);
  if (connectedError) {
    return connectedError;
  }

  const postResult = await context.postChannelMessage(channelResult.value, text, embed);
  if (!postResult.ok) {
    return jsonError(postResult.error, postResult.status);
  }
  return jsonOk({ ok: true, message: postResult.message, channel: postResult.channel });
}

/**
 * API の NICK 変更要求を処理する。
 */
export async function handleApiNick(request: Request, requestNickChange: ApiHandlerContext["requestNickChange"]): Promise<Response> {
  const bodyResult = await parseJsonBody<{ nick?: string }>(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const nickChangeResult = await requestNickChange(bodyResult.value.nick);
  if (!nickChangeResult.ok) {
    return jsonError(nickChangeResult.error, nickChangeResult.status);
  }
  return jsonOk({ ok: true, nick: nickChangeResult.nick });
}

/**
 * API の永続設定更新要求を処理する。
 */
export async function handleApiConfig(request: Request, context: ApiHandlerContext): Promise<Response> {
  const bodyResult = await parseJsonBody<unknown>(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const configUpdateResult = context.buildPersistedProxyConfigUpdate(context.instanceConfig, bodyResult.value);
  if (!configUpdateResult.ok) {
    return jsonError(configUpdateResult.error, configUpdateResult.status);
  }
  await context.persistProxyConfig(configUpdateResult.config);
  context.applyResolvedProxyConfig(configUpdateResult.config);
  const resolvedConfig = context.getResolvedConfig();
  return jsonOk({
    ok: true,
    config: {
      nick: resolvedConfig?.server.nick ?? null,
      autojoin: resolvedConfig?.autojoin ?? [],
    },
  });
}

/**
 * API のログ取得要求を処理する。
 */
export function handleApiLogs(channel: string, web: ApiHandlerContext["web"]): Response {
  const channelResult = validateChannelInput(channel);
  if (!channelResult.ok) {
    return jsonError(channelResult.error, 400);
  }
  const logs = web.getChannelLogs(channelResult.value);
  if (logs === null) {
    return jsonError("channel not found", 404);
  }
  return jsonOk({ channel: channelResult.value, messages: logs });
}

/**
 * API の手動切断要求を処理する。
 */
export async function handleApiDisconnect(context: ApiHandlerContext): Promise<Response> {
  const connectedError = requireConnected(context.serverConn as any);
  if (connectedError) {
    return connectedError;
  }
  context.setSuppressAutoReconnectOnClose(true);
  context.resetConnectionRecoveryState();
  await context.state.storage.deleteAlarm();
  await context.serverConn!.close();
  return jsonOk({ ok: true });
}
