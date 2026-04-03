import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));
vi.mock("./templates/style.css", () => ({ default: "" }));
vi.mock("./templates/channel.html", () => ({ default: "" }));
vi.mock("./templates/channel-list.html", () => ({ default: "" }));
vi.mock("./templates/login.html", () => ({ default: "" }));

import worker from "./index";

function makeEnv() {
  const fetch = vi.fn(async () => new Response("ok"));
  const get = vi.fn(() => ({ fetch }));
  const idFromName = vi.fn((name: string) => name);

  return {
    env: {
      API_KEY: "secret-token",
      IRC_PROXY: {
        idFromName,
        get,
      },
    } as unknown as Env,
    fetch,
    get,
    idFromName,
  };
}

describe("worker auth", () => {
  it("requires bearer auth for /api/connect", async () => {
    const { env, get } = makeEnv();

    const response = await worker.fetch(
      new Request("https://example.com/proxy/main/api/connect", { method: "POST" }),
      env
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(get).not.toHaveBeenCalled();
  });

  it("requires bearer auth for /api/leave", async () => {
    const { env, get } = makeEnv();

    const response = await worker.fetch(
      new Request("https://example.com/proxy/main/api/leave", { method: "POST" }),
      env
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(get).not.toHaveBeenCalled();
  });

  it("forwards /api/connect when bearer auth is present", async () => {
    const { env, fetch, get } = makeEnv();

    const response = await worker.fetch(
      new Request("https://example.com/proxy/main/api/connect", {
        method: "POST",
        headers: { Authorization: "Bearer secret-token" },
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(get).toHaveBeenCalledWith("main");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
