import { describe, expect, it } from "vitest";
import { buildProxyConfigFromEnv, parseBooleanEnv, parsePorts } from "../src/proxy-config";

describe("parseBooleanEnv", () => {
  it("treats common truthy values as enabled", () => {
    expect(parseBooleanEnv("true")).toBe(true);
    expect(parseBooleanEnv("1")).toBe(true);
    expect(parseBooleanEnv("yes")).toBe(true);
    expect(parseBooleanEnv("on")).toBe(true);
  });

  it("treats empty or unknown values as disabled", () => {
    expect(parseBooleanEnv(undefined)).toBe(false);
    expect(parseBooleanEnv("false")).toBe(false);
    expect(parseBooleanEnv("0")).toBe(false);
    expect(parseBooleanEnv("maybe")).toBe(false);
  });
});

describe("parsePorts", () => {
  it("supports single values, ranges, and lists", () => {
    expect(parsePorts("6667")).toEqual([6667]);
    expect(parsePorts("6660-6662")).toEqual([6660, 6661, 6662]);
    expect(parsePorts("6660, 6667,6697")).toEqual([6660, 6667, 6697]);
  });

  it("falls back to the default port when parsing fails", () => {
    expect(parsePorts("")).toEqual([6667]);
    expect(parsePorts("abc")).toEqual([6667]);
  });
});

describe("buildProxyConfigFromEnv", () => {
  it("maps auto-connect environment flags into proxy config", () => {
    const env = {
      IRC_PROXY: {} as DurableObjectNamespace,
      API_KEY: "token",
      IRC_HOST: "irc.example.com",
      IRC_PORT: "6667,6697",
      IRC_NICK: "apricot",
      IRC_USER: "apricot",
      IRC_REALNAME: "apricot IRC Proxy",
      IRC_TLS: "true",
      IRC_PASSWORD: "server-pass",
      CLIENT_PASSWORD: "client-pass",
      IRC_AUTO_CONNECT_ON_STARTUP: "true",
      IRC_AUTO_RECONNECT_ON_DISCONNECT: "1",
      IRC_AUTOJOIN: "#general,#test",
      KEEPALIVE_INTERVAL: "60",
      TIMEZONE_OFFSET: "9",
      IRC_ENCODING: "utf-8",
    } satisfies Env;

    expect(buildProxyConfigFromEnv(env)).toEqual({
      server: {
        host: "irc.example.com",
        port: 6667,
        nick: "apricot",
        user: "apricot",
        realname: "apricot IRC Proxy",
        tls: true,
        password: "server-pass",
        encoding: "utf-8",
      },
      ports: [6667, 6697],
      password: "client-pass",
      autojoin: ["#general", "#test"],
      autoConnectOnStartup: true,
      autoReconnectOnDisconnect: true,
    });
  });

  it("returns null when the IRC host is missing", () => {
    const env = {
      IRC_PROXY: {} as DurableObjectNamespace,
      API_KEY: "token",
      IRC_HOST: "",
      IRC_PORT: "6667",
      IRC_NICK: "apricot",
      IRC_USER: "apricot",
      IRC_REALNAME: "apricot IRC Proxy",
      IRC_TLS: "false",
      IRC_AUTOJOIN: "",
      KEEPALIVE_INTERVAL: "60",
    } as Env;

    expect(buildProxyConfigFromEnv(env)).toBeNull();
  });
});
