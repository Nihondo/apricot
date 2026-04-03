import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));
vi.mock("../templates/style.css", () => ({ default: "" }));
vi.mock("../templates/channel.html", () => ({
  default: "<html><body><h1>{{CHANNEL}}</h1><div>{{TOPIC}}</div>{{MESSAGES}}</body></html>",
}));
vi.mock("../templates/channel-list.html", () => ({ default: "{{CHANNEL_LINKS}}" }));

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
    KEEPALIVE_INTERVAL: "50",
    ...overrides,
  };
}

describe("IrcProxyDO web log persistence", () => {
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
});
