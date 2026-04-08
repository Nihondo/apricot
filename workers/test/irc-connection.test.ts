import { beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "cloudflare:sockets";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));

import { IrcServerConnection } from "../src/irc-connection";
import { createMockSocket } from "./helpers/mock-socket";

describe("IrcServerConnection", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(connect).mockReset();
  });

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
      async () => undefined,
    );

    await expect(connection.sendRaw("PING :ok\r\nPONG :bad")).rejects.toThrow("unsafe IRC line");
  });

  it("waits for socket.opened before sending IRC registration commands", async () => {
    const socket = createMockSocket();
    vi.mocked(connect).mockReturnValue(socket.socket);

    const connection = new IrcServerConnection(
      {
        host: "irc.example.com",
        port: 6667,
        nick: "apricot",
        user: "apricot",
        realname: "apricot IRC Proxy",
      },
      async () => undefined,
      async () => undefined,
    );

    const connectPromise = connection.connect();
    await Promise.resolve();
    expect(socket.writes).toEqual([]);

    socket.opened.resolve({} as SocketInfo);
    await connectPromise;

    expect(socket.writes.join("")).toContain("NICK apricot\r\n");
    expect(socket.writes.join("")).toContain("USER apricot 0 * :apricot IRC Proxy\r\n");
  });

  it("times out when the TCP socket never opens", async () => {
    vi.useFakeTimers();

    const socket = createMockSocket();
    vi.mocked(connect).mockReturnValue(socket.socket);

    const connection = new IrcServerConnection(
      {
        host: "irc.example.com",
        port: 6667,
        nick: "apricot",
        user: "apricot",
        realname: "apricot IRC Proxy",
      },
      async () => undefined,
      async () => undefined,
      { connectTimeoutMs: 50 },
    );

    const connectPromise = connection.connect();
    const connectExpectation = expect(connectPromise).rejects.toThrow("socket open timed out");
    await vi.advanceTimersByTimeAsync(50);

    await connectExpectation;
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("closes the connection when a write fails", async () => {
    const socket = createMockSocket();
    vi.mocked(connect).mockReturnValue(socket.socket);
    const onClose = vi.fn(async () => undefined);

    const connection = new IrcServerConnection(
      {
        host: "irc.example.com",
        port: 6667,
        nick: "apricot",
        user: "apricot",
        realname: "apricot IRC Proxy",
      },
      async () => undefined,
      onClose,
    );

    socket.opened.resolve({} as SocketInfo);
    await connection.connect();

    socket.failWrites(new Error("write failed"));
    await expect(connection.sendRaw("PING :health")).rejects.toThrow("write failed");

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes the close callback only once for manual close", async () => {
    const socket = createMockSocket();
    vi.mocked(connect).mockReturnValue(socket.socket);
    const onClose = vi.fn(async () => undefined);

    const connection = new IrcServerConnection(
      {
        host: "irc.example.com",
        port: 6667,
        nick: "apricot",
        user: "apricot",
        realname: "apricot IRC Proxy",
      },
      async () => undefined,
      onClose,
    );

    socket.opened.resolve({} as SocketInfo);
    await connection.connect();
    await connection.close();
    await Promise.resolve();

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
