/**
 * `irc-proxy` で使う共通レスポンス生成。
 */

/**
 * API 向けの共通 CORS ヘッダを返す。
 */
export function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
  };
}

/**
 * CORS ヘッダ付きの JSON 成功レスポンスを返す。
 */
export function jsonOk(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders() });
}

/**
 * CORS ヘッダ付きの JSON エラーレスポンスを返す。
 */
export function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: corsHeaders() });
}

/**
 * HTML レスポンスを返す。
 */
export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Location ヘッダ付きの 302 レスポンスを返す。
 */
export function redirectResponse(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...headers,
    },
  });
}

/**
 * 405 レスポンスを返す。
 */
export function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}

/**
 * 404 レスポンスを返す。
 */
export function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/**
 * 401 レスポンスを返す。
 */
export function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}
