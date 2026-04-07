import { describe, expect, it, vi } from "vitest";
import "./web-test-helpers";
import {
  handleApiConfig,
  handleApiDisconnect,
  handleApiJoin,
} from "../../src/irc-proxy/api-handlers";

describe("irc-proxy/api-handlers", () => {
  it("persists config updates and returns the resolved runtime config", async () => {
    let resolvedConfig = {
      server: { nick: "mainroom" },
      autojoin: [] as string[],
    };
    const persistProxyConfig = vi.fn(async () => undefined);
    const applyResolvedProxyConfig = vi.fn((config?: { nick?: string; autojoin?: string[] }) => {
      resolvedConfig = {
        server: { nick: config?.nick ?? "mainroom" },
        autojoin: config?.autojoin ?? [],
      };
    });

    const response = await handleApiConfig(new Request("https://example.com/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nick: "savednick", autojoin: ["#general", "#random"] }),
    }), {
      browserRenderingConfig: undefined,
      config: null,
      getResolvedConfig: () => resolvedConfig as any,
      instanceConfig: undefined,
      serverConn: null,
      state: { storage: { deleteAlarm: vi.fn() } } as any,
      web: { getChannelLogs: () => null },
      webUiSettings: {} as any,
      applyResolvedProxyConfig,
      buildPersistedProxyConfigUpdate: () => ({ ok: true, config: { nick: "savednick", autojoin: ["#general", "#random"] } }),
      persistProxyConfig,
      postChannelMessage: vi.fn(),
      requestNickChange: vi.fn(),
      setSuppressAutoReconnectOnClose: vi.fn(),
    });
    const payload = await response.json() as { config: { nick: string; autojoin: string[] } };

    expect(response.status).toBe(200);
    expect(persistProxyConfig).toHaveBeenCalledWith({ nick: "savednick", autojoin: ["#general", "#random"] });
    expect(applyResolvedProxyConfig).toHaveBeenCalled();
    expect(payload.config).toEqual({ nick: "savednick", autojoin: ["#general", "#random"] });
  });

  it("returns 400 for invalid join payloads", async () => {
    const response = await handleApiJoin(new Request("https://example.com/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general" }),
    }), {
      connected: true,
      send: vi.fn(),
      close: vi.fn(),
    });
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toContain("channel");
  });

  it("disconnects an active IRC connection through the shared helper", async () => {
    const close = vi.fn(async () => undefined);
    const deleteAlarm = vi.fn(async () => undefined);
    const setSuppressAutoReconnectOnClose = vi.fn();

    const response = await handleApiDisconnect({
      browserRenderingConfig: undefined,
      config: null,
      getResolvedConfig: () => null,
      instanceConfig: undefined,
      serverConn: {
        connected: true,
        send: vi.fn(),
        close,
      },
      state: { storage: { deleteAlarm } } as any,
      web: { getChannelLogs: () => null },
      webUiSettings: {} as any,
      applyResolvedProxyConfig: vi.fn(),
      buildPersistedProxyConfigUpdate: vi.fn(),
      persistProxyConfig: vi.fn(),
      postChannelMessage: vi.fn(),
      requestNickChange: vi.fn(),
      setSuppressAutoReconnectOnClose,
    });

    expect(response.status).toBe(200);
    expect(setSuppressAutoReconnectOnClose).toHaveBeenCalledWith(true);
    expect(deleteAlarm).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
