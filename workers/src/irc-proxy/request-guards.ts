/**
 * `irc-proxy` の入力ガードと前提チェック。
 */

import type { IrcServerConnection } from "../irc-connection";
import { jsonError } from "./response";

/**
 * JSON ボディを読み取り、失敗時は 400 レスポンスを返す。
 */
export async function parseJsonBody<T>(request: Request): Promise<
  | { ok: true; value: T }
  | { ok: false; response: Response }
> {
  try {
    return { ok: true, value: await request.json() as T };
  } catch {
    return { ok: false, response: jsonError("invalid JSON", 400) };
  }
}

/**
 * IRC 接続が必須の処理で、未接続時の 503 レスポンスを返す。
 */
export function requireConnected(serverConn: IrcServerConnection | null): Response | undefined {
  if (!serverConn?.connected) {
    return jsonError("not connected to IRC server", 503);
  }
  return undefined;
}
