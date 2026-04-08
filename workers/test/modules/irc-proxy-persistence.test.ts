import { beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "cloudflare:sockets";

const { extractUrlMetadataMock, resolveMessageEmbedMock, resolveUrlEmbedMock } = vi.hoisted(() => ({
  extractUrlMetadataMock: vi.fn(),
  resolveMessageEmbedMock: vi.fn(),
  resolveUrlEmbedMock: vi.fn(),
}));

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));
vi.mock("../../src/modules/url-metadata", () => ({
  extractUrlMetadata: extractUrlMetadataMock,
  resolveMessageEmbed: resolveMessageEmbedMock,
  resolveUrlEmbed: resolveUrlEmbedMock,
}));
vi.mock("../../src/templates/admin-style.css", () => ({ default: "ADMIN_CSS" }));
vi.mock("../../src/templates/style.css", () => ({ default: "" }));
vi.mock("../../src/templates/channel.html", () => ({
  default: "<html><head><style>{{CSS}}</style>{{THEME_CSS_LINK}}</head><body><div class=\"shell\">{{FRAME_CONTENT}}</div></body></html>",
}));
vi.mock("../../src/templates/channel-messages.html", () => ({
  default: "<html><head><style>{{CSS}}</style>{{THEME_CSS_LINK}}<script>{{AUTO_SCROLL_SCRIPT}}</script></head><body><div id=\"channel-messages-shell\">{{MESSAGES}}</div>{{RELOAD_BUTTON}}</body></html>",
}));
vi.mock("../../src/templates/channel-composer.html", () => ({
  default: "<html><head><style>{{CSS}}</style>{{THEME_CSS_LINK}}<script>{{ON_LOAD_SCRIPT}}</script></head><body>{{FLASH_MESSAGE}}<form action=\"{{ACTION_URL}}\" method=\"POST\">{{CHANNEL_LIST_LINK}}<input name=\"message\" value=\"{{MESSAGE_VALUE}}\"><button>送信</button></form></body></html>",
}));
vi.mock("../../src/templates/channel-list.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}{{FLASH_MESSAGE}}{{NICK_FORM}}{{STATUS_CLASS}}{{STATUS_TEXT}}{{CHANNEL_COUNT}}{{CHANNEL_LINKS}}{{CONFIG_PANEL}}</body></html>",
}));
vi.mock("../../src/templates/login.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{ERROR}}<form action=\"{{ACTION_URL}}\" method=\"POST\"><input name=\"password\"></form></body></html>",
}));
vi.mock("../../src/templates/settings.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}この設定はチャンネル画面にのみ適用されます。{{ERROR}}<form action=\"{{ACTION_URL}}\" method=\"POST\">{{COLOR_PREVIEW}}<input name=\"fontFamily\" value=\"{{FONT_FAMILY}}\"><input name=\"fontSizePx\" value=\"{{FONT_SIZE_PX}}\">{{PRESET_CONTROLS}}{{COLOR_FIELDS}}<input type=\"checkbox\" name=\"enableInlineUrlPreview\" {{ENABLE_INLINE_URL_PREVIEW_CHECKED}}><textarea name=\"extraCss\">{{EXTRA_CSS}}</textarea>{{DISPLAY_ORDER_ASC_CHECKED}}{{DISPLAY_ORDER_DESC_CHECKED}}</form>{{SETTINGS_SCRIPT}}</body></html>",
}));

import { IrcProxyDO } from "../../src/irc-proxy";
import type { PersistedWebLogs, WebUiSettings } from "../../src/modules/web";
import { createMockSocket } from "../helpers/mock-socket";

const webLogsStorageKey = "web:logs:v1";
const webUiSettingsStorageKey = "web:ui-settings:v1";
const proxyConfigStorageKey = "proxy:config:v1";
const proxyIdStorageKey = "proxy:id";

class FakeStorage {
  private values = new Map<string, unknown>();
  lastAlarmAt: number | null = null;
  alarmTimes: number[] = [];
  deleteAlarmCalls = 0;

  seed(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }

  read<T>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.read<T>(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async setAlarm(time: number): Promise<void> {
    this.lastAlarmAt = time;
    this.alarmTimes.push(time);
  }

  async deleteAlarm(): Promise<void> {
    this.lastAlarmAt = null;
    this.deleteAlarmCalls += 1;
  }
}

class FakeState {
  storage = new FakeStorage();
  initPromise: Promise<unknown> = Promise.resolve();
  acceptedWebSockets: WebSocket[] = [];

  acceptWebSocket(ws: WebSocket): void {
    this.acceptedWebSockets.push(ws);
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const promise = callback();
    this.initPromise = promise;
    return promise;
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    IRC_PROXY: {} as DurableObjectNamespace,
    API_KEY: "token",
    IRC_HOST: "irc.example.com",
    IRC_PORT: "6667",
    IRC_NICK: "apricot",
    IRC_USER: "apricot",
    IRC_REALNAME: "apricot IRC Proxy",
    IRC_TLS: "false",
    IRC_AUTOJOIN: "",
    KEEPALIVE_INTERVAL: "60",
    ...overrides,
  };
}

async function loginWeb(proxy: IrcProxyDO): Promise<string> {
  const response = await proxy.fetch(new Request("https://example.com/web/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Proxy-Prefix": "/proxy/main",
    },
    body: "password=secret",
  }));
  return response.headers.get("Set-Cookie")?.split(";")[0] ?? "";
}

describe("IrcProxyDO web log persistence", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.mocked(connect).mockReset();
    extractUrlMetadataMock.mockReset();
    resolveMessageEmbedMock.mockReset();
    resolveUrlEmbedMock.mockReset();
    extractUrlMetadataMock.mockImplementation(async (url: string) => url);
    resolveMessageEmbedMock.mockResolvedValue(undefined);
    resolveUrlEmbedMock.mockResolvedValue(undefined);
  });

  it("returns 503 for web UI when CLIENT_PASSWORD is not configured", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: undefined })
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));

    expect(response.status).toBe(503);
  });

  it("stores proxy id on first fetch and uses it as the default nick", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/api/status", {
      headers: {
        "X-Proxy-Id": "mainroom",
        "X-Proxy-Prefix": "/proxy/mainroom",
      },
    }));
    const payload = await response.json() as { nick: string };

    expect(payload.nick).toBe("mainroom");
    expect(state.storage.read<string>(proxyIdStorageKey)).toBe("mainroom");
  });

  it("prefers persisted proxy config over proxy id defaults", async () => {
    const state = new FakeState();
    state.storage.seed(proxyIdStorageKey, "mainroom");
    state.storage.seed(proxyConfigStorageKey, {
      nick: "savednick",
      autojoin: ["#saved"],
    });

    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/api/status", {
      headers: { "X-Proxy-Prefix": "/proxy/mainroom" },
    }));
    const payload = await response.json() as { nick: string };

    expect(payload.nick).toBe("savednick");
    expect((proxy as any).config?.autojoin).toEqual(["#saved"]);
  });

  it("persists per-proxy config updates through PUT /api/config", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/api/config", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Id": "mainroom",
        "X-Proxy-Prefix": "/proxy/mainroom",
      },
      body: JSON.stringify({
        nick: "savednick",
        autojoin: ["#general", "#random"],
      }),
    }));
    const payload = await response.json() as {
      config: { nick: string; autojoin: string[] };
    };

    expect(response.status).toBe(200);
    expect(payload.config).toEqual({
      nick: "savednick",
      autojoin: ["#general", "#random"],
    });
    expect(state.storage.read(proxyConfigStorageKey)).toEqual({
      nick: "savednick",
      autojoin: ["#general", "#random"],
    });
  });

  it("renders persisted proxy config controls in the authenticated channel list page", async () => {
    const state = new FakeState();
    state.storage.seed(proxyConfigStorageKey, {
      nick: "savednick",
      autojoin: ["#general", "#random"],
    });
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const response = await proxy.fetch(new Request("https://example.com/web/", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('action="/proxy/main/web/config"');
    expect(html).toContain("接続デフォルト設定");
    expect(html).toContain('name="nick" value="savednick"');
    expect(html).toContain("#general\n#random");
    expect(html).toContain("現在のNICKを変更");
  });

  it("persists proxy config updates through POST /web/config", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const response = await proxy.fetch(new Request("https://example.com/web/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "nick=savednick&autojoin=%23general%0A%23random",
    }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("接続デフォルト設定を保存しました");
    expect(state.storage.read(proxyConfigStorageKey)).toEqual({
      nick: "savednick",
      autojoin: ["#general", "#random"],
    });
  });

  it("clears persisted proxy config through POST /web/config with blank values", async () => {
    const state = new FakeState();
    state.storage.seed(proxyConfigStorageKey, {
      nick: "savednick",
      autojoin: ["#general", "#random"],
    });
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const response = await proxy.fetch(new Request("https://example.com/web/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "nick=&autojoin=",
    }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("接続デフォルト設定をクリアしました");
    expect(state.storage.read(proxyConfigStorageKey)).toBeUndefined();
    expect(html).toContain('name="nick" value=""');
  });

  it("keeps invalid web config form input and shows a validation error", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const response = await proxy.fetch(new Request("https://example.com/web/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "nick=savednick&autojoin=general",
    }));
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("接続デフォルト設定の保存に失敗しました");
    expect(html).toContain("invalid channel");
    expect(html).toContain("general");
    expect(state.storage.read(proxyConfigStorageKey)).toBeUndefined();
  });

  it("hydrates persisted logs into the restored web messages page", async () => {
    const state = new FakeState();
    state.storage.seed(webLogsStorageKey, {
      "#general": [
        { time: 1, type: "privmsg", nick: "alice", text: "restored line" },
      ],
    } satisfies PersistedWebLogs);

    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const response = await proxy.fetch(new Request("https://example.com/web/%23general/messages", {
      headers: { Cookie: cookieHeader, "X-Proxy-Prefix": "/proxy/main" },
    }));
    const html = await response.text();

    expect(html).toContain("restored line");
  });

  it("renders the web messages fragment route with sequence headers", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    await (proxy as any).handleServerMessage({
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "fragment body"],
    });

    const response = await proxy.fetch(new Request("https://example.com/web/%23general/messages/fragment", {
      headers: { Cookie: cookieHeader, "X-Proxy-Prefix": "/proxy/main" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Apricot-Channel-Sequence")).toBe("1");
    expect(response.headers.get("X-Apricot-Fragment-Start-Sequence")).toBe("0");
    expect(response.headers.get("X-Apricot-Fragment-Mode")).toBe("full");
    expect(await response.text()).toContain("fragment body");
  });

  it("renders the channel shell page with messages and composer iframes", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const response = await proxy.fetch(new Request("https://example.com/web/%23general", {
      headers: { Cookie: cookieHeader, "X-Proxy-Prefix": "/proxy/main" },
    }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('/proxy/main/web/%23general/composer');
    expect(html).toContain('/proxy/main/web/%23general/messages');
  });

  it("does not add stored-only channels to the channel list until rejoined", async () => {
    const state = new FakeState();
    state.storage.seed(webLogsStorageKey, {
      "#general": [
        { time: 1, type: "privmsg", nick: "alice", text: "restored line" },
      ],
    } satisfies PersistedWebLogs);

    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const listBeforeJoin = await proxy.fetch(new Request("https://example.com/web/", {
      headers: { Cookie: cookieHeader, "X-Proxy-Prefix": "/proxy/main" },
    }));
    expect(await listBeforeJoin.text()).not.toContain('/proxy/main/web/%23general');

    await (proxy as any).handleServerMessage({
      prefix: "apricot!proxy@apricot",
      command: "JOIN",
      params: ["#general"],
    });

    const listAfterJoin = await proxy.fetch(new Request("https://example.com/web/", {
      headers: { Cookie: cookieHeader, "X-Proxy-Prefix": "/proxy/main" },
    }));
    expect(await listAfterJoin.text()).toContain('/proxy/main/web/%23general');
  });

  it("persists both server messages and self messages to storage", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    await (proxy as any).handleServerMessage({
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "hello from server"],
    });

    let logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"][0]).toMatchObject({
      type: "privmsg",
      nick: "alice",
      text: "hello from server",
    });

    await (proxy as any).web.recordSelfMessage("#general", "apricot", "hello from self");

    logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"][1]).toMatchObject({
      type: "self",
      nick: "apricot",
      text: "hello from self",
    });
  });

  it("redirects unauthenticated web requests to the login page", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/proxy/main/web/login");
  });

  it("returns 503 for /web/settings when CLIENT_PASSWORD is not configured", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: undefined })
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/settings", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));

    expect(response.status).toBe(503);
  });

  it("renders login page errors with 401 on wrong password", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "password=wrong",
    }));

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("パスワードが違います");
  });

  it("issues a cookie for correct web login and allows authenticated access", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const loginResponse = await proxy.fetch(new Request("https://example.com/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "password=secret",
    }));

    expect(loginResponse.status).toBe(302);
    expect(loginResponse.headers.get("Location")).toBe("/proxy/main/web/");

    const setCookie = loginResponse.headers.get("Set-Cookie");
    expect(setCookie).toContain("apricot_web_auth=");
    expect(setCookie).toContain("Path=/proxy/main/web");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    const cookieHeader = setCookie?.split(";")[0] ?? "";
    const pageResponse = await proxy.fetch(new Request("https://example.com/web/", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));

    expect(pageResponse.status).toBe(200);
  });

  it("renders persisted settings in the authenticated settings page", async () => {
    const state = new FakeState();
    state.storage.seed(webUiSettingsStorageKey, {
      fontFamily: "\"Fira Sans\", sans-serif",
      fontSizePx: 18,
      textColor: "#123456",
      surfaceColor: "#ABCDEF",
      surfaceAltColor: "#FEDCBA",
      accentColor: "#0F0F0F",
      borderColor: "#654321",
      usernameColor: "#AA5500",
      timestampColor: "#00AA55",
      highlightColor: "#998800",
      buttonColor: "#001122",
      buttonTextColor: "#F0F0F0",
      selfColor: "#00CCFF",
      mutedTextColor: "#666666",
      keywordColor: "#D84315",
      displayOrder: "asc",
      extraCss: ".channel-shell { color: blue; }",
      highlightKeywords: "",
      dimKeywords: "",
      enableInlineUrlPreview: true,
    } satisfies WebUiSettings);
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const loginResponse = await proxy.fetch(new Request("https://example.com/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "password=secret",
    }));
    const cookieHeader = loginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

    const response = await proxy.fetch(new Request("https://example.com/web/settings", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("&quot;Fira Sans&quot;, sans-serif");
    expect(html).toContain(".channel-shell {");
    expect(html).toContain("color: blue;");
    expect(html).toContain("この設定はチャンネル画面にのみ適用されます。");
    expect(html).toContain("ADMIN_CSS");
    expect(html).toContain('data-theme-preview-root');
    expect(html).toContain('data-theme-preview-frame');
    expect(html).not.toContain('data-theme-preview-messages');
    expect(html).not.toContain('data-theme-preview-composer');
    expect(html).toContain("/proxy/main/web/");
    expect(html).toContain('name="borderColor"');
    expect(html).toContain('value="#654321"');
    expect(html).toContain('data-theme-preset="dark"');
    expect(html).toContain('name="enableInlineUrlPreview"');
    expect(html).toContain("checked");
  });

  it("fills missing theme fields from the light preset for legacy stored settings", async () => {
    const state = new FakeState();
    state.storage.seed(webUiSettingsStorageKey, {
      fontFamily: "\"Fira Sans\", sans-serif",
      fontSizePx: 18,
      textColor: "#123456",
      surfaceColor: "#ABCDEF",
      surfaceAltColor: "#FEDCBA",
      accentColor: "#0F0F0F",
      displayOrder: "asc",
      extraCss: "body { color: blue; }",
    } satisfies Partial<WebUiSettings>);
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const loginResponse = await proxy.fetch(new Request("https://example.com/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "password=secret",
    }));
    const cookieHeader = loginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

    const response = await proxy.fetch(new Request("https://example.com/web/settings", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('name="borderColor"');
    expect(html).toContain('value="#0B5FFF"');
    expect(html).toContain('name="buttonTextColor"');
    expect(html).toContain('value="#FFFFFF"');
    expect(html).not.toContain("body { color: blue; }");
    expect(html).not.toMatch(/name="enableInlineUrlPreview"[^>]*checked/);
  });

  it("persists web UI settings and applies them across list, shell, messages, composer, and login pages", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const loginResponse = await proxy.fetch(new Request("https://example.com/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "password=secret",
    }));
    const cookieHeader = loginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

    const response = await proxy.fetch(new Request("https://example.com/web/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: [
        "fontFamily=%22Fira%20Sans%22%2C%20sans-serif",
        "fontSizePx=18",
        "textColor=%23123456",
        "surfaceColor=%23ABCDEF",
        "surfaceAltColor=%23FEDCBA",
        "accentColor=%230F0F0F",
        "borderColor=%23654321",
        "usernameColor=%23AA5500",
        "timestampColor=%2300AA55",
        "highlightColor=%23998800",
        "buttonColor=%23001122",
        "buttonTextColor=%23F0F0F0",
        "selfColor=%2300CCFF",
        "mutedTextColor=%23666666",
        "keywordColor=%23FF4400",
        "displayOrder=asc",
        "enableInlineUrlPreview=1",
        "extraCss=.channel-shell%20%7B%20color%3A%20blue%3B%20%7D",
        "highlightKeywords=hello%0Aworld",
        "dimKeywords=NickServ",
      ].join("&"),
    }));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/proxy/main/web/");
    expect(state.storage.read<WebUiSettings>(webUiSettingsStorageKey)).toEqual({
      fontFamily: "\"Fira Sans\", sans-serif",
      fontSizePx: 18,
      textColor: "#123456",
      surfaceColor: "#ABCDEF",
      surfaceAltColor: "#FEDCBA",
      accentColor: "#0F0F0F",
      borderColor: "#654321",
      usernameColor: "#AA5500",
      timestampColor: "#00AA55",
      highlightColor: "#998800",
      buttonColor: "#001122",
      buttonTextColor: "#F0F0F0",
      selfColor: "#00CCFF",
      mutedTextColor: "#666666",
      keywordColor: "#FF4400",
      displayOrder: "asc",
      enableInlineUrlPreview: true,
      extraCss: ".channel-shell {\n  color: blue;\n}",
      highlightKeywords: "hello\nworld",
      dimKeywords: "NickServ",
    });

    await (proxy as any).handleServerMessage({
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "hello"],
    });

    const listPage = await proxy.fetch(new Request("https://example.com/web/", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    const listHtml = await listPage.text();
    expect(listHtml).toContain("設定");
    expect(listHtml).toContain("ADMIN_CSS");
    expect(listHtml).not.toContain("font-size: 18px;");
    expect(listHtml).not.toContain(".channel-shell");

    const channelPage = await proxy.fetch(new Request("https://example.com/web/%23general", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    const channelHtml = await channelPage.text();
    expect(channelHtml).toContain('/proxy/main/web/%23general/messages');
    expect(channelHtml).toContain('/proxy/main/web/%23general/composer');
    expect(channelHtml).toContain('/proxy/main/web/theme.css');
    expect(channelHtml).toContain("--border-color: #654321;");
    expect(channelHtml).toContain("--link-bg: rgba(15,15,15,0.2);");

    const messagesPage = await proxy.fetch(new Request("https://example.com/web/%23general/messages", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    const messagesHtml = await messagesPage.text();
    expect(messagesHtml).toContain("hello");
    expect(messagesHtml).toContain("nearBottomThreshold = 48");
    expect(messagesHtml).toContain("sessionStorage.getItem");
    expect(messagesHtml).not.toContain("再読込");
    expect(messagesHtml).toContain('/proxy/main/web/theme.css');

    const composerPage = await proxy.fetch(new Request("https://example.com/web/%23general/composer", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    const composerHtml = await composerPage.text();
    expect(composerHtml).toContain('action="/proxy/main/web/%23general/composer"');
    expect(composerHtml).toContain('href="/proxy/main/web/"');
    expect(composerHtml).toContain('window.addEventListener("wheel"');
    expect(composerHtml).toContain('window.addEventListener("touchmove"');
    expect(composerHtml).toContain('/proxy/main/web/theme.css');

    const themeResponse = await proxy.fetch(new Request("https://example.com/web/theme.css", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    expect(themeResponse.status).toBe(200);
    expect(await themeResponse.text()).toContain(".channel-shell {");

    const loginPage = await proxy.fetch(new Request("https://example.com/web/login", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));
    const loginHtml = await loginPage.text();
    expect(loginHtml).toContain("ADMIN_CSS");
    expect(loginHtml).not.toContain("font-size: 18px;");
    expect(loginHtml).not.toContain(".channel-shell");
  });

  it("rejects invalid web UI settings without persisting them", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const loginResponse = await proxy.fetch(new Request("https://example.com/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "password=secret",
    }));
    const cookieHeader = loginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

    const response = await proxy.fetch(new Request("https://example.com/web/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "fontFamily=test&fontSizePx=10&textColor=%23000000&surfaceColor=%23FFFFFF&surfaceAltColor=%23EEEEEE&accentColor=%230000FF&borderColor=blue&usernameColor=%23000011&timestampColor=%23000022&highlightColor=%23000033&buttonColor=%23000044&buttonTextColor=%23FFFFFF&selfColor=%23000055&mutedTextColor=%23666666&displayOrder=desc&extraCss=",
    }));
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("borderColor は #RRGGBB 形式で入力してください");
    expect(state.storage.read(webUiSettingsStorageKey)).toBeUndefined();
  });

  it("returns 404 for the removed /web/display-order route", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const loginResponse = await proxy.fetch(new Request("https://example.com/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "password=secret",
    }));
    const cookieHeader = loginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

    const response = await proxy.fetch(new Request("https://example.com/web/display-order", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));

    expect(response.status).toBe(404);
  });

  it("requires the auth cookie for posting from the web composer route", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    (proxy as any).serverConn = {
      connected: true,
      send: vi.fn(),
    };

    const blockedResponse = await proxy.fetch(new Request("https://example.com/web/%23general/composer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "message=hello",
    }));
    expect(blockedResponse.status).toBe(302);
    expect(blockedResponse.headers.get("Location")).toBe("/proxy/main/web/login");

    const loginResponse = await proxy.fetch(new Request("https://example.com/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "password=secret",
    }));
    const cookieHeader = loginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";

    const allowedResponse = await proxy.fetch(new Request("https://example.com/web/%23general/composer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "message=hello",
    }));

    expect(allowedResponse.status).toBe(200);
    expect(await allowedResponse.text()).toContain("channel-messages-frame");
    expect((proxy as any).serverConn.send).toHaveBeenCalledWith({
      command: "PRIVMSG",
      params: ["#general", "hello"],
    });
  });

  it("allows IRC formatting control codes when posting from the web composer route", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const send = vi.fn();
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const cookieHeader = await loginWeb(proxy);
    const formattedMessage = "\u0002bold\u0002 \u000304green\u000f";
    const response = await proxy.fetch(new Request("https://example.com/web/%23general/composer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: new URLSearchParams({ message: formattedMessage }).toString(),
    }));

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith({
      command: "PRIVMSG",
      params: ["#general", formattedMessage],
    });
  });

  it("requires the auth cookie for the web updates route and accepts an authenticated websocket", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const blockedResponse = await proxy.fetch(new Request("https://example.com/web/%23general/updates", {
      headers: {
        "Upgrade": "websocket",
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    expect(blockedResponse.status).toBe(401);

    const loginResponse = await proxy.fetch(new Request("https://example.com/web/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "password=secret",
    }));
    const cookieHeader = loginResponse.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    const acceptWebUpdatesSocket = vi
      .spyOn(proxy as any, "acceptWebUpdatesSocket")
      .mockReturnValue(new Response(null, { status: 200 }));

    const allowedResponse = await proxy.fetch(new Request("https://example.com/web/%23general/updates", {
      headers: {
        "Cookie": cookieHeader,
        "Upgrade": "websocket",
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));

    expect(allowedResponse.status).toBe(200);
    expect(acceptWebUpdatesSocket).toHaveBeenCalledWith("#general");
  });

  it("renders the web messages and composer routes and records self messages on composer post", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const composerResponse = await proxy.fetch(new Request("https://example.com/web/%23general/composer", {
      headers: { Cookie: cookieHeader, "X-Proxy-Prefix": "/proxy/main" },
    }));
    expect(composerResponse.status).toBe(200);
    expect(await composerResponse.text()).toContain('action="/proxy/main/web/%23general/composer"');

    const postResponse = await proxy.fetch(new Request("https://example.com/web/%23general/composer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "message=hello",
    }));
    const postHtml = await postResponse.text();
    expect(postResponse.status).toBe(200);
    expect(postHtml).toContain("channel-messages-frame");

    const messagesResponse = await proxy.fetch(new Request("https://example.com/web/%23general/messages", {
      headers: { Cookie: cookieHeader, "X-Proxy-Prefix": "/proxy/main" },
    }));
    const messagesHtml = await messagesResponse.text();
    expect(messagesResponse.status).toBe(200);
    expect(messagesHtml).toContain("hello");

    const logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"]?.at(-1)).toMatchObject({
      type: "self",
      nick: "apricot",
      text: "hello",
    });
    expect(send).toHaveBeenCalledWith({
      command: "PRIVMSG",
      params: ["#general", "hello"],
    });
  });

  it("broadcasts web update notifications only to subscribers of the changed channel", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const generalSubscriber = { send: vi.fn() };
    const randomSubscriber = { send: vi.fn() };
    (proxy as any).webUpdateSubscribers.set(generalSubscriber, "#general");
    (proxy as any).webUpdateSubscribers.set(randomSubscriber, "#random");

    await (proxy as any).handleServerMessage({
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "server update"],
    });

    expect(generalSubscriber.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: "channel-updated", channel: "#general", sequence: 1 })
    );
    expect(randomSubscriber.send).not.toHaveBeenCalled();

    await proxy.fetch(new Request("https://example.com/web/%23general/composer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "message=client-update",
    }));

    expect(generalSubscriber.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: "channel-updated", channel: "#general", sequence: 2 })
    );
    expect(randomSubscriber.send).not.toHaveBeenCalled();
  });

  it("responds to heartbeat ping on web update sockets without invoking client registration", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const updateSocket = { send: vi.fn() } as unknown as WebSocket;
    const otherUpdateSocket = { send: vi.fn() } as unknown as WebSocket;
    (proxy as any).webUpdateSubscribers.set(updateSocket, "#general");
    (proxy as any).webUpdateSubscribers.set(otherUpdateSocket, "#general");
    const handleClientRegistration = vi.spyOn(proxy as any, "handleClientRegistration");

    await proxy.webSocketMessage(updateSocket, JSON.stringify({ type: "ping" }));

    expect(updateSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "pong" }));
    expect(otherUpdateSocket.send).not.toHaveBeenCalled();
    expect(handleClientRegistration).not.toHaveBeenCalled();
  });

  it("removes only the closed web update subscriber", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const firstUpdateSocket = { send: vi.fn() } as unknown as WebSocket;
    const secondUpdateSocket = { send: vi.fn() } as unknown as WebSocket;
    (proxy as any).webUpdateSubscribers.set(firstUpdateSocket, "#general");
    (proxy as any).webUpdateSubscribers.set(secondUpdateSocket, "#random");

    await proxy.webSocketClose(firstUpdateSocket, 1001, "closing", true);

    expect((proxy as any).webUpdateSubscribers.has(firstUpdateSocket)).toBe(false);
    expect((proxy as any).webUpdateSubscribers.get(secondUpdateSocket)).toBe("#random");
  });

  it("escapes only the server-bound composer message for non-utf8 encodings", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret", IRC_ENCODING: "iso-2022-jp" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const postResponse = await proxy.fetch(new Request("https://example.com/web/%23general/composer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: new URLSearchParams({ message: "hello😀" }).toString(),
    }));
    const postHtml = await postResponse.text();
    expect(postResponse.status).toBe(200);
    expect(postHtml).toContain("channel-messages-frame");

    const messagesResponse = await proxy.fetch(new Request("https://example.com/web/%23general/messages", {
      headers: { Cookie: cookieHeader, "X-Proxy-Prefix": "/proxy/main" },
    }));
    const messagesHtml = await messagesResponse.text();
    expect(messagesResponse.status).toBe(200);
    expect(messagesHtml).toContain("hello😀");

    const logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"]?.at(-1)).toMatchObject({
      type: "self",
      nick: "apricot",
      text: "hello😀",
    });
    expect(send).toHaveBeenCalledWith({
      command: "PRIVMSG",
      params: ["#general", "hello&#x1F600;"],
    });
  });

  it("returns the original API message while escaping only the server-bound message", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ IRC_ENCODING: "iso-2022-jp" })
    );
    await state.initPromise;

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/api/post", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "#general", message: "hello😀" }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      channel: "#general",
      message: "hello😀",
    });
    expect(send).toHaveBeenCalledWith({
      command: "PRIVMSG",
      params: ["#general", "hello&#x1F600;"],
    });

    const logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"]?.at(-1)).toMatchObject({
      type: "self",
      nick: "apricot",
      text: "hello😀",
    });
  });

  it("stores URL embed metadata for API url posts while keeping the generated message text", async () => {
    extractUrlMetadataMock.mockResolvedValue("Example title https://example.com/post");
    resolveUrlEmbedMock.mockResolvedValue({
      kind: "card",
      sourceUrl: "https://example.com/post",
      imageUrl: "https://example.com/card.jpg",
      title: "Example title",
      siteName: "Example",
    });
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/api/post", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "#general", url: "https://example.com/post" }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      channel: "#general",
      message: "Example title https://example.com/post",
    });
    const logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"]?.at(-1)).toMatchObject({
      type: "self",
      nick: "apricot",
      text: "Example title https://example.com/post",
      embed: {
        kind: "card",
        sourceUrl: "https://example.com/post",
        imageUrl: "https://example.com/card.jpg",
        title: "Example title",
        siteName: "Example",
      },
    });
  });

  it("passes Browser Rendering credentials to URL title extraction for API url posts", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_BROWSER_RENDERING_API_TOKEN: "token-xyz",
      })
    );
    await state.initPromise;

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";
    extractUrlMetadataMock.mockResolvedValue("Rendered title https://example.com/post");
    resolveUrlEmbedMock.mockResolvedValue(undefined);

    const response = await proxy.fetch(new Request("https://example.com/api/post", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "#general", url: "https://example.com/post" }),
    }));

    expect(response.status).toBe(200);
    expect(extractUrlMetadataMock).toHaveBeenCalledWith("https://example.com/post", {
      browserRendering: {
        accountId: "account-123",
        apiToken: "token-xyz",
      },
    });
  });

  it("resolves embed via resolveMessageEmbed for API message posts when ENABLE_REMOTE_URL_PREVIEW is on", async () => {
    const embed = {
      kind: "card" as const,
      sourceUrl: "https://example.com/post",
      imageUrl: "https://example.com/card.jpg",
      title: "Example title",
      siteName: "Example",
    };
    resolveMessageEmbedMock.mockResolvedValue(embed);
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ ENABLE_REMOTE_URL_PREVIEW: "true" })
    );
    await state.initPromise;

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = { connected: true, send };
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "#general", message: "check https://example.com/post" }),
    }));

    expect(response.status).toBe(200);
    expect(resolveMessageEmbedMock).toHaveBeenCalledTimes(1);
    const logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"]?.at(-1)).toMatchObject({
      type: "self",
      text: "check https://example.com/post",
      embed,
    });
  });

  it("does not call resolveMessageEmbed when embed is already resolved by the caller (API url mode)", async () => {
    const embed = {
      kind: "card" as const,
      sourceUrl: "https://example.com/post",
      title: "Example title",
      siteName: "Example",
    };
    resolveUrlEmbedMock.mockResolvedValue(embed);
    extractUrlMetadataMock.mockResolvedValue("Example title https://example.com/post");
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ ENABLE_REMOTE_URL_PREVIEW: "true" })
    );
    await state.initPromise;

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = { connected: true, send };
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "#general", url: "https://example.com/post" }),
    }));

    expect(response.status).toBe(200);
    expect(resolveMessageEmbedMock).not.toHaveBeenCalled();
    const logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"]?.at(-1)).toMatchObject({ embed });
  });

  it("returns 503 immediately without calling resolveMessageEmbed when not connected and ENABLE_REMOTE_URL_PREVIEW is on", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ ENABLE_REMOTE_URL_PREVIEW: "true" })
    );
    await state.initPromise;

    // serverConn is not set (disconnected)
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "#general", message: "check https://example.com/post" }),
    }));

    expect(response.status).toBe(503);
    expect(resolveMessageEmbedMock).not.toHaveBeenCalled();
  });

  it("does not call resolveMessageEmbed for API message posts when ENABLE_REMOTE_URL_PREVIEW is off", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = { connected: true, send };
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "#general", message: "check https://example.com/post" }),
    }));

    expect(response.status).toBe(200);
    expect(resolveMessageEmbedMock).not.toHaveBeenCalled();
    const logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"]?.at(-1)).toMatchObject({
      type: "self",
      text: "check https://example.com/post",
    });
    expect(logs?.["#general"]?.at(-1)?.embed).toBeUndefined();
  });

  it("stores message without embed when resolveMessageEmbed throws", async () => {
    resolveMessageEmbedMock.mockRejectedValue(new Error("network error"));
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ ENABLE_REMOTE_URL_PREVIEW: "true" })
    );
    await state.initPromise;

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = { connected: true, send };
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "#general", message: "check https://example.com/post" }),
    }));

    expect(response.status).toBe(200);
    const logs = state.storage.read<PersistedWebLogs>(webLogsStorageKey);
    expect(logs?.["#general"]?.at(-1)).toMatchObject({
      type: "self",
      text: "check https://example.com/post",
    });
    expect(logs?.["#general"]?.at(-1)?.embed).toBeUndefined();
  });

  it("clears the cookie on logout", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/logout", {
      method: "POST",
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/proxy/main/web/login");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("sends NICK when the nick-change API is called", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const send = vi.fn();
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    // Start request without awaiting — it will pause waiting for server confirmation
    const responsePromise = proxy.fetch(new Request("https://example.com/api/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: JSON.stringify({ nick: "apricot_alt" }),
    }));

    // Yield until handleApiNick progresses to setting pendingNickChange
    while (!(proxy as any).pendingNickChange) {
      await Promise.resolve();
    }

    // Simulate server confirming the NICK change
    await (proxy as any).handleServerMessage({
      prefix: "apricot!user@host",
      command: "NICK",
      params: ["apricot_alt"],
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, nick: "apricot_alt" });
    expect(send).toHaveBeenCalledWith({
      command: "NICK",
      params: ["apricot_alt"],
    });
  });

  it("accepts nick changes when the server reply arrives before send resolves", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const send = vi.fn(async () => {
      await (proxy as any).handleServerMessage({
        prefix: "apricot!user@host",
        command: "NICK",
        params: ["apricot_alt"],
      });
    });
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/api/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: JSON.stringify({ nick: "apricot_alt" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, nick: "apricot_alt" });
    expect(send).toHaveBeenCalledWith({
      command: "NICK",
      params: ["apricot_alt"],
    });
  });

  it("accepts nick changes when the confirmation has no prefix but matches the requested nick", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const send = vi.fn(async () => {
      await (proxy as any).handleServerMessage({
        command: "NICK",
        params: ["apricot_alt"],
      });
    });
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/api/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: JSON.stringify({ nick: "apricot_alt" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, nick: "apricot_alt" });
  });

  it("returns nick-related server errors instead of timing out", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const send = vi.fn();
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const responsePromise = proxy.fetch(new Request("https://example.com/api/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: JSON.stringify({ nick: "apricot_alt" }),
    }));

    while (!(proxy as any).pendingNickChange) {
      await Promise.resolve();
    }

    await (proxy as any).handleServerMessage({
      prefix: "irc.example.com",
      command: "438",
      params: ["apricot", "apricot_alt", "Nick change too fast. Please wait a while and try again."],
    });

    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Nick change too fast. Please wait a while and try again.",
    });
  });

  it("rejects nick-change API requests while disconnected", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/api/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: JSON.stringify({ nick: "apricot_alt" }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not connected to IRC server" });
  });

  it("changes nick from the web channel list and shows a success banner", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const send = vi.fn(async () => {
      await (proxy as any).handleServerMessage({
        prefix: "apricot!user@host",
        command: "NICK",
        params: ["apricot_alt"],
      });
    });
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const response = await proxy.fetch(new Request("https://example.com/web/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "nick=apricot_alt",
    }));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("NICKを apricot_alt に変更しました");
    expect(html).toContain('value="apricot_alt"');
    expect(send).toHaveBeenCalledWith({
      command: "NICK",
      params: ["apricot_alt"],
    });
  });

  it("shows a web nick-change error banner while disconnected", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: "secret" })
    );
    await state.initPromise;
    const cookieHeader = await loginWeb(proxy);

    const response = await proxy.fetch(new Request("https://example.com/web/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "nick=apricot_alt",
    }));
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(html).toContain("NICK変更に失敗しました: not connected to IRC server");
    expect(html).toContain('value="apricot_alt"');
  });

  it("returns 503 for web nick changes when CLIENT_PASSWORD is not configured", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: undefined })
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "nick=apricot_public",
    }));

    expect(response.status).toBe(503);
  });

  it("validates nick-change API input", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/api/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: JSON.stringify({ nick: "   " }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "missing nick" });
  });

  it("sends PART when the leave API is called", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const send = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = {
      connected: true,
      send,
    };

    const response = await proxy.fetch(new Request("https://example.com/api/leave", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: JSON.stringify({ channel: "#general" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, channel: "#general" });
    expect(send).toHaveBeenCalledWith({
      command: "PART",
      params: ["#general"],
    });
  });

  it("rejects leave API requests while disconnected", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/api/leave", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: JSON.stringify({ channel: "#general" }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not connected to IRC server" });
  });

  it("validates leave API input", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/api/leave", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: JSON.stringify({ channel: "" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "missing channel" });
  });

  it("disconnects from IRC via API", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const close = vi.fn().mockResolvedValue(undefined);
    (proxy as any).serverConn = {
      connected: true,
      close,
    };

    const response = await proxy.fetch(new Request("https://example.com/api/disconnect", {
      method: "POST",
      headers: {
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects disconnect API requests while disconnected", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/api/disconnect", {
      method: "POST",
      headers: {
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not connected to IRC server" });
  });

  it("suppresses auto reconnect after manual disconnect", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ IRC_AUTO_RECONNECT_ON_DISCONNECT: "true" })
    );
    await state.initPromise;

    (proxy as any).suppressAutoReconnectOnClose = true;

    expect((proxy as any).consumeAutoReconnectOnClose()).toBe(false);
    expect((proxy as any).suppressAutoReconnectOnClose).toBe(false);
    expect((proxy as any).consumeAutoReconnectOnClose()).toBe(true);
  });

  it("does not block status requests while startup auto-connect is still pending", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ IRC_AUTO_CONNECT_ON_STARTUP: "true" }),
    );
    await state.initPromise;

    const socket = createMockSocket();
    vi.mocked(connect).mockReturnValue(socket.socket);

    const response = await proxy.fetch(new Request("https://example.com/api/status", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: false, nick: "apricot" });
    expect(connect).toHaveBeenCalledTimes(1);
    expect((proxy as any).connectPromise).toBeTruthy();
  });

  it("waits for 001 before treating the IRC connection as established", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv(),
    );
    await state.initPromise;

    const socket = createMockSocket();
    vi.mocked(connect).mockReturnValue(socket.socket);

    let hasResolved = false;
    const connectPromise = (proxy as any).ensureServerConnection().then(() => {
      hasResolved = true;
    });

    socket.opened.resolve({} as SocketInfo);
    await Promise.resolve();
    await Promise.resolve();

    expect((proxy as any).serverConn?.connected).toBe(false);
    expect(hasResolved).toBe(false);

    socket.pushMessage(":irc.example.com 001 apricot :Welcome");
    await connectPromise;

    expect((proxy as any).serverConn?.connected).toBe(true);
    expect((proxy as any).reconnectAttempt).toBe(0);
    expect(state.storage.alarmTimes.length).toBeGreaterThan(0);
  });

  it("fails over to the next port when registration times out", async () => {
    vi.useFakeTimers();

    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({
        IRC_PORT: "6667,6668",
        IRC_REGISTRATION_TIMEOUT_MS: "100",
      }),
    );
    await state.initPromise;

    const firstSocket = createMockSocket();
    const secondSocket = createMockSocket();
    vi.mocked(connect)
      .mockReturnValueOnce(firstSocket.socket)
      .mockReturnValueOnce(secondSocket.socket);

    const connectPromise = (proxy as any).ensureServerConnection();
    firstSocket.opened.resolve({} as SocketInfo);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(100);
    secondSocket.opened.resolve({} as SocketInfo);
    await Promise.resolve();
    secondSocket.pushMessage(":irc.example.com 001 apricot :Welcome");
    await connectPromise;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(firstSocket.close).toHaveBeenCalled();
    expect((proxy as any).serverConn?.connected).toBe(true);
  });

  it("extends registration wait while pre-registration server messages are still arriving", async () => {
    vi.useFakeTimers();

    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({
        IRC_REGISTRATION_TIMEOUT_MS: "100",
      }),
    );
    await state.initPromise;

    const socket = createMockSocket();
    vi.mocked(connect).mockReturnValue(socket.socket);

    const connectPromise = (proxy as any).ensureServerConnection();
    socket.opened.resolve({} as SocketInfo);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(90);
    socket.pushMessage(":irc.friend-chat.jp NOTICE AUTH :*** Looking up your hostname...");
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(90);
    expect((proxy as any).serverConn).toBeTruthy();

    socket.pushMessage(":irc.friend-chat.jp 001 apricot :Welcome");
    await connectPromise;

    expect((proxy as any).serverConn?.connected).toBe(true);
  });

  it("schedules exponential reconnect backoff after a failed reconnect attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T00:00:00Z"));

    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({
        IRC_AUTO_RECONNECT_ON_DISCONNECT: "true",
        IRC_RECONNECT_BASE_DELAY_MS: "5000",
        IRC_RECONNECT_MAX_DELAY_MS: "60000",
        IRC_RECONNECT_JITTER_RATIO: "0",
      }),
    );
    await state.initPromise;

    const socket = createMockSocket();
    vi.mocked(connect).mockReturnValue(socket.socket);
    socket.opened.reject(new Error("tcp open failed"));

    await (proxy as any).alarm();

    expect((proxy as any).reconnectAttempt).toBe(1);
    expect(state.storage.lastAlarmAt).toBe(Date.now() + 5000);
  });

  it("sends a health-check ping after idle time and reconnects on ping timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T00:00:00Z"));

    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({
        IRC_AUTO_RECONNECT_ON_DISCONNECT: "true",
        IRC_RECONNECT_BASE_DELAY_MS: "5000",
        IRC_RECONNECT_JITTER_RATIO: "0",
        IRC_IDLE_PING_INTERVAL_MS: "10",
        IRC_PING_TIMEOUT_MS: "20",
      }),
    );
    await state.initPromise;

    const socket = createMockSocket();
    vi.mocked(connect).mockReturnValue(socket.socket);

    const connectPromise = (proxy as any).ensureServerConnection();
    socket.opened.resolve({} as SocketInfo);
    await Promise.resolve();
    socket.pushMessage(":irc.example.com 001 apricot :Welcome");
    await connectPromise;

    (proxy as any).lastServerActivityAt = Date.now() - 100;
    await (proxy as any).alarm();

    expect(socket.writes.at(-1)).toContain("PING apricot:");

    await vi.advanceTimersByTimeAsync(25);
    await (proxy as any).alarm();

    expect(socket.close).toHaveBeenCalled();
    expect((proxy as any).reconnectAttempt).toBe(1);
    expect(state.storage.lastAlarmAt).toBe(Date.now() + 5000);
  });

  it("ignores stale close callbacks from older connection generations", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv(),
    );
    await state.initPromise;

    const sentinelConn = { connected: true };
    (proxy as any).connectionGeneration = 2;
    (proxy as any).serverConn = sentinelConn;

    await (proxy as any).handleServerClose(1);

    expect((proxy as any).serverConn).toBe(sentinelConn);
    expect(state.storage.deleteAlarmCalls).toBe(0);
  });
});
