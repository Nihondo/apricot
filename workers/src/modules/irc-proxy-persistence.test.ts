import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));
vi.mock("../templates/style.css", () => ({ default: "" }));
vi.mock("../templates/channel.html", () => ({
  default: "<html><body><form action=\"{{LOGOUT_URL}}\"></form><h1>{{CHANNEL}}</h1><div>{{TOPIC}}</div>{{MESSAGES}}</body></html>",
}));
vi.mock("../templates/channel-list.html", () => ({
  default: "<html><body><form action=\"{{LOGOUT_URL}}\"></form>{{CHANNEL_LINKS}}</body></html>",
}));
vi.mock("../templates/login.html", () => ({
  default: "<html><body>{{ERROR}}<form action=\"{{ACTION_URL}}\" method=\"POST\"><input name=\"password\"></form></body></html>",
}));

import { IrcProxyDO } from "../irc-proxy";
import type { PersistedWebLogs } from "./web";

const webLogsStorageKey = "web:logs:v1";

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
