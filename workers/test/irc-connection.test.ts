import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));

import { IrcServerConnection } from "../src/irc-connection";

describe("IrcServerConnection", () => {
  it("rejects raw lines containing embedded line breaks", async () => {
    const connection = new IrcServerConnection(
      {
        host: "irc.example.com",
        port: 6667,
        nick: "apricot",
        user: "apricot",
        realname: "apricot IRC Proxy",
      },
      async () => undefined,
      async () => undefined
    );

    await expect(connection.sendRaw("PING :ok\r\nPONG :bad")).rejects.toThrow("unsafe IRC line");
  });
});
