import { beforeEach, describe, expect, it, vi } from "vitest";
import "./web-test-helpers";
import { createWebModule } from "../../src/modules/web-module";
import { buildWebUiSettings } from "../../src/modules/web-theme";
import type { PersistedWebLogs } from "../../src/modules/web-types";
import { makeContext, resolveMessageEmbedMock } from "./web-test-helpers";

describe("web-module", () => {
  beforeEach(() => {
    resolveMessageEmbedMock.mockReset();
    resolveMessageEmbedMock.mockResolvedValue(undefined);
  });

  it("records IRC events into lowercase channel snapshots", async () => {
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
    expect(snapshot["#general"][0]).toMatchObject({ nick: "alice", text: "hello" });
    expect(snapshot["#random"][0]).toMatchObject({ text: "maintenance" });
  });

  it("hydrates logs and rebuilds visible channel state", async () => {
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

    const html = restored.buildChannelMessagesPage(
      "#general",
      restored.getChannelTopic("#general"),
      "apricot",
    );

    expect(html).toContain("welcome topic");
    expect(html).toContain("hello world");
    expect(html).toContain("alice&gt;");
  });

  it("invokes the channel logs changed callback after store updates", async () => {
    const onChannelLogsChanged = vi.fn();
    const web = createWebModule(new Map(), 0, undefined, 200, onChannelLogsChanged);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "hello"],
    });
    await web.recordSelfMessage("#general", "apricot", "self");

    expect(onChannelLogsChanged).toHaveBeenNthCalledWith(1, ["#general"]);
    expect(onChannelLogsChanged).toHaveBeenNthCalledWith(2, ["#general"]);
  });

  it("hydrates legacy persisted logs by backfilling sequences", () => {
    const snapshot: PersistedWebLogs = {
      "#general": [
        { time: 1, type: "privmsg", nick: "alice", text: "msg-1" },
        { time: 2, type: "privmsg", nick: "bob", text: "msg-2" },
      ],
    };

    const web = createWebModule(new Map(), 0);
    web.hydrateLogs(snapshot);

    expect(web.getChannelLatestSequence("#general")).toBe(2);
    expect(web.snapshotLogs()["#general"]).toMatchObject([
      { sequence: 1, text: "msg-1" },
      { sequence: 2, text: "msg-2" },
    ]);
  });

  it("resolves embeds for incoming messages when remote preview is enabled", async () => {
    resolveMessageEmbedMock.mockResolvedValue({
      kind: "image",
      sourceUrl: "https://cdn.example.com/cat.jpg",
      imageUrl: "https://cdn.example.com/cat.jpg",
    });
    const web = createWebModule(new Map(), 0, undefined, 200, undefined, true);
    const ctx = makeContext();

    await web.module.handlers.get("ss_privmsg")?.(ctx, {
      prefix: "alice!user@host",
      command: "PRIVMSG",
      params: ["#general", "look https://cdn.example.com/cat.jpg"],
    });

    const html = web.buildChannelMessagesPage(
      "#general",
      "",
      "apricot",
      buildWebUiSettings({ enableInlineUrlPreview: true }),
    );

    expect(resolveMessageEmbedMock).toHaveBeenCalledTimes(1);
    expect(html).toContain("url-embed-container");
    expect(html).toContain('src="https://cdn.example.com/cat.jpg"');
  });
});
