import { describe, expect, it } from "vitest";
import { createWebStore } from "../../src/modules/web-store";
import type { PersistedWebLogs } from "../../src/modules/web-types";

describe("web-store", () => {
  it("stores snapshots grouped by lowercase channel names", async () => {
    const store = createWebStore({ maxLines: 200 });

    await store.appendMessage("#General", {
      time: 1,
      type: "privmsg",
      nick: "alice",
      text: "hello",
    });
    await store.appendMessage("#random", {
      time: 2,
      type: "notice",
      nick: "server",
      text: "maintenance",
    });

    const snapshot = store.snapshotLogs();
    expect(Object.keys(snapshot).sort()).toEqual(["#general", "#random"]);
    expect(snapshot["#general"][0]).toMatchObject({ text: "hello", sequence: 1 });
    expect(snapshot["#random"][0]).toMatchObject({ text: "maintenance", sequence: 1 });
  });

  it("hydrates legacy persisted logs by backfilling sequences", () => {
    const snapshot: PersistedWebLogs = {
      "#general": [
        { time: 1, type: "privmsg", nick: "alice", text: "msg-1" },
        { time: 2, type: "privmsg", nick: "bob", text: "msg-2" },
      ],
    };

    const store = createWebStore({ maxLines: 200 });
    store.hydrateLogs(snapshot);

    expect(store.getChannelLatestSequence("#general")).toBe(2);
    expect(store.snapshotLogs()["#general"]).toMatchObject([
      { sequence: 1, text: "msg-1" },
      { sequence: 2, text: "msg-2" },
    ]);
  });

  it("trims restored logs to the latest maxLines messages", () => {
    const snapshot: PersistedWebLogs = {
      "#general": Array.from({ length: 250 }, (_, index) => ({
        time: index,
        type: "privmsg" as const,
        nick: "alice",
        text: `msg-${index}`,
      })),
    };

    const store = createWebStore({ maxLines: 200 });
    store.hydrateLogs(snapshot);

    const restored = store.snapshotLogs();
    expect(restored["#general"]).toHaveLength(200);
    expect(restored["#general"][0].text).toBe("msg-50");
    expect(restored["#general"][199].text).toBe("msg-249");
  });
});
