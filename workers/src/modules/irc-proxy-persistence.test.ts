import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));
vi.mock("../templates/admin-style.css", () => ({ default: "ADMIN_CSS" }));
vi.mock("../templates/style.css", () => ({ default: "" }));
vi.mock("../templates/channel.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{LOGOUT_FORM}}<div style=\"{{CONTENT_PADDING}}\">{{INPUT_BAR_POSITION}}{{RELOAD_BUTTON}}<h1>{{CHANNEL}}</h1><div>{{TOPIC}}</div>{{MESSAGES}}</div></body></html>",
}));
vi.mock("../templates/channel-list.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}{{FLASH_MESSAGE}}{{NICK_FORM}}{{STATUS_CLASS}}{{STATUS_TEXT}}{{CHANNEL_COUNT}}{{CHANNEL_LINKS}}</body></html>",
}));
vi.mock("../templates/login.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{ERROR}}<form action=\"{{ACTION_URL}}\" method=\"POST\"><input name=\"password\"></form></body></html>",
}));
vi.mock("../templates/settings.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}この設定はチャンネル画面にのみ適用されます。{{ERROR}}{{PRESET_CONTROLS}}<form action=\"{{ACTION_URL}}\" method=\"POST\"><input name=\"fontFamily\" value=\"{{FONT_FAMILY}}\"><input name=\"fontSizePx\" value=\"{{FONT_SIZE_PX}}\">{{COLOR_FIELDS}}<textarea name=\"extraCss\">{{EXTRA_CSS}}</textarea>{{DISPLAY_ORDER_ASC_CHECKED}}{{DISPLAY_ORDER_DESC_CHECKED}}</form>{{SETTINGS_SCRIPT}}</body></html>",
}));

import { IrcProxyDO } from "../irc-proxy";
import type { PersistedWebLogs, WebUiSettings } from "./web";

const webLogsStorageKey = "web:logs:v1";
const webUiSettingsStorageKey = "web:ui-settings:v1";

class FakeStorage {
  private values = new Map<string, unknown>();
  private alarmTime: number | null = null;

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

  async setAlarm(time: number): Promise<void> {
    this.alarmTime = time;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmTime = null;
  }
}

class FakeState {
  storage = new FakeStorage();
  initPromise: Promise<unknown> = Promise.resolve();

  acceptWebSocket(_ws: WebSocket): void {}

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

describe("IrcProxyDO web log persistence", () => {
  it("keeps web UI public when CLIENT_PASSWORD is not configured", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: undefined })
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));

    expect(response.status).toBe(200);
  });

  it("hydrates persisted logs into the restored web page", async () => {
    const state = new FakeState();
    state.storage.seed(webLogsStorageKey, {
      "#general": [
        { time: 1, type: "privmsg", nick: "alice", text: "restored line" },
      ],
    } satisfies PersistedWebLogs);

    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/%23general", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));
    const html = await response.text();

    expect(html).toContain("restored line");
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
      makeEnv()
    );
    await state.initPromise;

    const listBeforeJoin = await proxy.fetch(new Request("https://example.com/web/", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));
    expect(await listBeforeJoin.text()).not.toContain("#general");

    await (proxy as any).handleServerMessage({
      prefix: "apricot!proxy@apricot",
      command: "JOIN",
      params: ["#general"],
    });

    const listAfterJoin = await proxy.fetch(new Request("https://example.com/web/", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));
    expect(await listAfterJoin.text()).toContain("#general");
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

  it("returns 404 for /web/settings when CLIENT_PASSWORD is not configured", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: undefined })
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/settings", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));

    expect(response.status).toBe(404);
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
      displayOrder: "asc",
      extraCss: "body { color: blue; }",
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
    expect(html).toContain("body { color: blue; }");
    expect(html).toContain("この設定はチャンネル画面にのみ適用されます。");
    expect(html).toContain("ADMIN_CSS");
    expect(html).not.toContain("font-size: 18px;");
    expect(html).toContain("/proxy/main/web/");
    expect(html).toContain('name="borderColor"');
    expect(html).toContain('value="#654321"');
    expect(html).toContain('data-theme-preset="dark"');
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
  });

  it("persists web UI settings and applies them across list, channel, and login pages", async () => {
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
        "displayOrder=asc",
        "extraCss=body%20%7B%20color%3A%20blue%3B%20%7D",
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
      displayOrder: "asc",
      extraCss: "body { color: blue; }",
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
    expect(listHtml).not.toContain("body { color: blue; }</style>");

    const channelPage = await proxy.fetch(new Request("https://example.com/web/%23general", {
      headers: {
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
    }));
    const channelHtml = await channelPage.text();
    expect(channelHtml).toContain("padding-bottom:45px;");
    expect(channelHtml).not.toContain("再読込");
    expect(channelHtml).toContain("body { color: blue; }");
    expect(channelHtml).not.toContain("設定");
    expect(channelHtml).toContain("--border-color: #654321;");
    expect(channelHtml).toContain("--link-bg: rgba(15,15,15,0.2);");

    const loginPage = await proxy.fetch(new Request("https://example.com/web/login", {
      headers: { "X-Proxy-Prefix": "/proxy/main" },
    }));
    const loginHtml = await loginPage.text();
    expect(loginHtml).toContain("ADMIN_CSS");
    expect(loginHtml).not.toContain("font-size: 18px;");
    expect(loginHtml).not.toContain("body { color: blue; }</style>");
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

  it("requires the auth cookie for posting from the web UI", async () => {
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

    const blockedResponse = await proxy.fetch(new Request("https://example.com/web/%23general", {
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

    const allowedResponse = await proxy.fetch(new Request("https://example.com/web/%23general", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "message=hello",
    }));

    expect(allowedResponse.status).toBe(302);
    expect(allowedResponse.headers.get("Location")).toBe("/proxy/main/web/%23general");
    expect((proxy as any).serverConn.send).toHaveBeenCalledWith({
      command: "PRIVMSG",
      params: ["#general", "hello"],
    });
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
      makeEnv()
    );
    await state.initPromise;

    const send = vi.fn();
    (proxy as any).serverConn = {
      connected: true,
      send,
    };
    (proxy as any).nick = "apricot";

    const responsePromise = proxy.fetch(new Request("https://example.com/web/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "nick=apricot_alt",
    }));

    while (!(proxy as any).pendingNickChange) {
      await Promise.resolve();
    }

    await (proxy as any).handleServerMessage({
      prefix: "apricot!user@host",
      command: "NICK",
      params: ["apricot_alt"],
    });

    const response = await responsePromise;
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
      makeEnv()
    );
    await state.initPromise;

    const response = await proxy.fetch(new Request("https://example.com/web/nick", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "nick=apricot_alt",
    }));
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(html).toContain("NICK変更に失敗しました: not connected to IRC server");
    expect(html).toContain('value="apricot_alt"');
  });

  it("allows web nick changes on a public web UI without authentication", async () => {
    const state = new FakeState();
    const proxy = new IrcProxyDO(
      state as unknown as DurableObjectState,
      makeEnv({ CLIENT_PASSWORD: undefined })
    );
    await state.initPromise;

    const send = vi.fn(async () => {
      await (proxy as any).handleServerMessage({
        prefix: "apricot!user@host",
        command: "NICK",
        params: ["apricot_public"],
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
        "X-Proxy-Prefix": "/proxy/main",
      },
      body: "nick=apricot_public",
    }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("NICKを apricot_public に変更しました");
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
});
