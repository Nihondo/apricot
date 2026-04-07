/**
 * Web UI 向けの POST ハンドラ群。
 */

import { validateChannelInput } from "../input-validation";
import type { ProxyInstanceConfig } from "../proxy-config";
import type { WebUiSettings } from "../modules/web";
import { buildExpiredWebAuthCookie, buildWebAuthCookie, buildWebAuthCookieValue } from "./web-auth";
import { htmlResponse, redirectResponse } from "./response";
import { validateWebUiSettingsForm } from "./web-settings";

type NickChangeResult =
  | { ok: true; nick: string }
  | { ok: false; error: string; status: number };
type PostMessageResult =
  | { ok: true; message: string; channel: string }
  | { ok: false; error: string; status: number };
type PersistedProxyConfigUpdate =
  | { ok: true; config?: ProxyInstanceConfig }
  | { ok: false; error: string; status: number };

interface WebHandlerContext {
  configPassword?: string;
  currentSettings: WebUiSettings;
  instanceConfig?: ProxyInstanceConfig;
  serverConn: {
    connected: boolean;
    send(message: { command: string; params: string[] }): Promise<void>;
  } | null;
  applyResolvedProxyConfig(config?: ProxyInstanceConfig): void;
  buildPersistedProxyConfigUpdate(
    currentConfig: ProxyInstanceConfig | undefined,
    body: unknown,
  ): PersistedProxyConfigUpdate;
  buildWebChannelListPage(
    webBase: string,
    options?: {
      nick?: string;
      flashMessage?: string;
      flashTone?: "info" | "danger";
      configFormValues?: { nick: string; autojoin: string };
    },
  ): string;
  buildWebPersistedConfigFormValues(config?: ProxyInstanceConfig): { nick: string; autojoin: string };
  persistProxyConfig(config?: ProxyInstanceConfig): Promise<void>;
  persistWebUiSettings(settings: WebUiSettings): Promise<void>;
  postChannelMessage(channel: string | undefined, message: string | undefined): Promise<PostMessageResult>;
  renderWebChannelComposerPage(
    channel: string,
    webBase: string,
    messageValue?: string,
    flashMessage?: string,
    flashTone?: "info" | "danger",
    status?: number,
    shouldReloadMessages?: boolean,
  ): Response;
  renderWebLoginPage(actionUrl: string, errorMessage?: string, status?: number): Response;
  renderWebSettingsPage(webBase: string, settings?: WebUiSettings, errorMessage?: string, status?: number): Response;
  requestNickChange(nick: string | undefined): Promise<NickChangeResult>;
}

function readWebPersistedConfigFormValues(formData: FormData): { nick: string; autojoin: string } {
  const nickValue = formData.get("nick");
  const autojoinValue = formData.get("autojoin");
  return {
    nick: typeof nickValue === "string" ? nickValue : "",
    autojoin: typeof autojoinValue === "string" ? autojoinValue : "",
  };
}

function buildPersistedProxyConfigUpdateFromFormData(
  currentConfig: ProxyInstanceConfig | undefined,
  formData: FormData,
  buildPersistedProxyConfigUpdate: WebHandlerContext["buildPersistedProxyConfigUpdate"],
):
  | { ok: true; config?: ProxyInstanceConfig; formValues: { nick: string; autojoin: string } }
  | { ok: false; error: string; status: number; formValues: { nick: string; autojoin: string } } {
  const formValues = readWebPersistedConfigFormValues(formData);
  const autojoin = formValues.autojoin
    .split(/\r?\n/u)
    .map((channel) => channel.trim())
    .filter(Boolean);
  const configUpdateResult = buildPersistedProxyConfigUpdate(currentConfig, {
    nick: formValues.nick,
    autojoin,
  });
  return { ...configUpdateResult, formValues };
}

/**
 * Web UI のログイン POST を処理する。
 */
export async function handleWebLogin(
  request: Request,
  proxyPrefix: string,
  webBase: string,
  context: Pick<WebHandlerContext, "configPassword" | "renderWebLoginPage">,
): Promise<Response> {
  if (!context.configPassword) {
    return redirectResponse(`${webBase}/`);
  }
  const formData = await request.formData();
  const password = (formData.get("password") as string | null)?.trim() ?? "";
  if (password !== context.configPassword) {
    return context.renderWebLoginPage(`${webBase}/login`, "パスワードが違います", 401);
  }
  const cookieValue = await buildWebAuthCookieValue(proxyPrefix, context.configPassword);
  return redirectResponse(`${webBase}/`, {
    "Set-Cookie": buildWebAuthCookie(cookieValue, `${proxyPrefix}/web`, request.url),
  });
}

/**
 * Web UI のログアウト POST を処理する。
 */
export async function handleWebLogout(
  request: Request,
  proxyPrefix: string,
  webBase: string,
): Promise<Response> {
  return redirectResponse(`${webBase}/login`, {
    "Set-Cookie": buildExpiredWebAuthCookie(`${proxyPrefix}/web`, request.url),
  });
}

/**
 * Web UI の NICK 変更 POST を処理する。
 */
export async function handleWebNick(
  request: Request,
  webBase: string,
  context: Pick<WebHandlerContext, "buildWebChannelListPage" | "requestNickChange">,
): Promise<Response> {
  const formData = await request.formData();
  const nick = (formData.get("nick") as string | null) ?? "";
  const nickChangeResult = await context.requestNickChange(nick);
  if (!nickChangeResult.ok) {
    return htmlResponse(
      context.buildWebChannelListPage(webBase, {
        nick,
        flashMessage: `NICK変更に失敗しました: ${nickChangeResult.error}`,
        flashTone: "danger",
      }),
      nickChangeResult.status,
    );
  }
  return htmlResponse(
    context.buildWebChannelListPage(webBase, {
      nick: nickChangeResult.nick,
      flashMessage: `NICKを ${nickChangeResult.nick} に変更しました`,
      flashTone: "info",
    }),
  );
}

/**
 * Web UI の接続デフォルト設定保存 POST を処理する。
 */
export async function handleWebConfig(
  request: Request,
  webBase: string,
  context: Pick<WebHandlerContext, "instanceConfig" | "buildPersistedProxyConfigUpdate" | "persistProxyConfig" | "applyResolvedProxyConfig" | "buildWebPersistedConfigFormValues" | "buildWebChannelListPage">,
): Promise<Response> {
  const formData = await request.formData();
  const configUpdateResult = buildPersistedProxyConfigUpdateFromFormData(
    context.instanceConfig,
    formData,
    context.buildPersistedProxyConfigUpdate,
  );
  if (!configUpdateResult.ok) {
    return htmlResponse(
      context.buildWebChannelListPage(webBase, {
        flashMessage: `接続デフォルト設定の保存に失敗しました: ${configUpdateResult.error}`,
        flashTone: "danger",
        configFormValues: configUpdateResult.formValues,
      }),
      configUpdateResult.status,
    );
  }
  await context.persistProxyConfig(configUpdateResult.config);
  context.applyResolvedProxyConfig(configUpdateResult.config);
  const successMessage = configUpdateResult.config
    ? "接続デフォルト設定を保存しました"
    : "接続デフォルト設定をクリアしました";
  return htmlResponse(
    context.buildWebChannelListPage(webBase, {
      flashMessage: successMessage,
      flashTone: "info",
      configFormValues: context.buildWebPersistedConfigFormValues(configUpdateResult.config),
    }),
  );
}

/**
 * Web UI の composer POST を処理する。
 */
export async function handleWebChannelComposer(
  request: Request,
  channel: string,
  webBase: string,
  context: Pick<WebHandlerContext, "postChannelMessage" | "renderWebChannelComposerPage">,
): Promise<Response> {
  const formData = await request.formData();
  const messageValue = (formData.get("message") as string | null) ?? "";
  const postResult = await context.postChannelMessage(channel, messageValue);
  if (!postResult.ok) {
    return context.renderWebChannelComposerPage(
      channel,
      webBase,
      messageValue,
      `送信に失敗しました: ${postResult.error}`,
      "danger",
      postResult.status,
      false,
    );
  }
  return context.renderWebChannelComposerPage(channel, webBase, "", "", "info", 200, true);
}

/**
 * Web UI の表示設定保存 POST を処理する。
 */
export async function handleWebSettings(
  request: Request,
  webBase: string,
  context: Pick<WebHandlerContext, "currentSettings" | "persistWebUiSettings" | "renderWebSettingsPage">,
): Promise<Response> {
  const formData = await request.formData();
  const validation = validateWebUiSettingsForm(formData, context.currentSettings);
  if (validation.errorMessage) {
    return context.renderWebSettingsPage(webBase, validation.settings, validation.errorMessage, 400);
  }
  await context.persistWebUiSettings(validation.settings);
  return redirectResponse(`${webBase}/`);
}

/**
 * Web UI の JOIN POST を処理する。
 */
export async function handleWebJoin(
  request: Request,
  webBase: string,
  buildWebChannelListPage: WebHandlerContext["buildWebChannelListPage"],
  serverConn: WebHandlerContext["serverConn"],
): Promise<Response> {
  const formData = await request.formData();
  const channelResult = validateChannelInput(formData.get("channel") as string | null);
  if (!channelResult.ok) {
    return htmlResponse(
      buildWebChannelListPage(webBase, {
        flashMessage: `JOIN に失敗しました: ${channelResult.error}`,
        flashTone: "danger",
      }),
      400,
    );
  }
  if (!serverConn?.connected) {
    return htmlResponse(
      buildWebChannelListPage(webBase, {
        flashMessage: "JOIN に失敗しました: not connected to IRC server",
        flashTone: "danger",
      }),
      503,
    );
  }
  await serverConn.send({ command: "JOIN", params: [channelResult.value] });
  return redirectResponse(`${webBase}/`);
}

/**
 * Web UI の PART POST を処理する。
 */
export async function handleWebLeave(
  request: Request,
  webBase: string,
  buildWebChannelListPage: WebHandlerContext["buildWebChannelListPage"],
  serverConn: WebHandlerContext["serverConn"],
): Promise<Response> {
  const formData = await request.formData();
  const channelResult = validateChannelInput(formData.get("channel") as string | null);
  if (!channelResult.ok) {
    return htmlResponse(
      buildWebChannelListPage(webBase, {
        flashMessage: `PART に失敗しました: ${channelResult.error}`,
        flashTone: "danger",
      }),
      400,
    );
  }
  if (!serverConn?.connected) {
    return htmlResponse(
      buildWebChannelListPage(webBase, {
        flashMessage: "PART に失敗しました: not connected to IRC server",
        flashTone: "danger",
      }),
      503,
    );
  }
  await serverConn.send({ command: "PART", params: [channelResult.value] });
  return redirectResponse(`${webBase}/`);
}
