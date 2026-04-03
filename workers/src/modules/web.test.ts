import { describe, expect, it, vi } from "vitest";
import type { ModuleContext } from "../module-system";

vi.mock("../templates/style.css", () => ({ default: "" }));
vi.mock("../templates/channel.html", () => ({
  default: "<html><body><h1>{{CHANNEL}}</h1><div>{{TOPIC}}</div><form action=\"{{ACTION_URL}}\"></form>{{MESSAGES}}</body></html>",
}));
vi.mock("../templates/channel-list.html", () => ({ default: "{{CHANNEL_LINKS}}" }));

import { createWebModule, type PersistedWebLogs } from "./web";

function makeContext(overrides: Partial<ModuleContext> = {}): ModuleContext {
  return {
    userno: 0,
    connno: 0,
    sendToServer: async () => undefined,
    sendToClients: () => undefined,
    getProperty: () => undefined,
    nick: "apricot",
    channels: [],
    serverName: "irc.example.com",
    ...overrides,
  };
}

describe("createWebModule", () => {
  it("returns snapshot logs grouped by lowercase channel", async () => {
    const web = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#General", "hello"],
    });
    await web.module.handlers.get("ss_notice")?.(ctx, {
      prefix: "server.example.com",
      command: "NOTICE",
      params: ["#random", "maintenance"],
    });

    const snapshot = web.snapshotLogs();
    expect(Object.keys(snapshot).sort()).toEqual(["#general", "#random"]);
    expect(snapshot["#general"][0]).toMatchObject({
      type: "privmsg",
      nick: "alice",
      text: "hello",
    });
    expect(snapshot["#random"][0]).toMatchObject({
      type: "notice",
      text: "maintenance",
    });
  });

  it("hydrates logs and rebuilds the same visible channel contents", async () => {
    const source = createWebModule(new Map(), 0);
    const ctx = makeContext();

    await source.module.handlers.get("ss_topic")?.(ctx, {
      prefix: "alice!user@host",
      command: "TOPIC",
      params: ["#general", "welcome topic"],
    });
    await source.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "hello world"],
    });

    const restored = createWebModule(new Map(), 0);
    restored.hydrateLogs(source.snapshotLogs());

    expect(restored.getChannelTopic("#general")).toBe("welcome topic");

    const html = restored.buildChannelPage(
      "#general",
      restored.getChannelTopic("#general"),
      "apricot",
      "/proxy/main/web"
    );

    expect(html).toContain("welcome topic");
    expect(html).toContain("hello world");
    expect(html).toContain("alice&gt;");
  });

  it("trims restored logs to the latest 200 messages", () => {
    const snapshot: PersistedWebLogs = {
      "#general": Array.from({ length: 250 }, (_, index) => ({
        time: index,
        type: "privmsg",
        nick: "alice",
        text: `msg-${index}`,
      })),
    };

    const web = createWebModule(new Map(), 0);
    web.hydrateLogs(snapshot);

    const restored = web.snapshotLogs();
    expect(restored["#general"]).toHaveLength(200);
    expect(restored["#general"][0].text).toBe("msg-50");
    expect(restored["#general"][199].text).toBe("msg-249");
  });
});
