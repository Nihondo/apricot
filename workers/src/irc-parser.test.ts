/**
 * Unit tests for irc-parser.ts
 * These cover the parse/build round-trip and edge cases.
 */

import { describe, it, expect } from "vitest";
import { parse, build, extractNick, isChannel } from "./irc-parser";

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

describe("parse", () => {
  it("parses a bare PING", () => {
    const msg = parse("PING :irc.example.com");
    expect(msg.command).toBe("PING");
    expect(msg.params).toEqual(["irc.example.com"]);
    expect(msg.prefix).toBeUndefined();
  });

  it("parses a message with prefix", () => {
    const msg = parse(":nick!user@host PRIVMSG #channel :hello world");
    expect(msg.prefix).toBe("nick!user@host");
    expect(msg.command).toBe("PRIVMSG");
    expect(msg.params).toEqual(["#channel", "hello world"]);
  });

  it("parses multiple non-trailing params", () => {
    const msg = parse(":server 353 mynick = #channel :nick1 @nick2 +nick3");
    expect(msg.command).toBe("353");
    expect(msg.params).toEqual(["mynick", "=", "#channel", "nick1 @nick2 +nick3"]);
  });

  it("normalises command to uppercase", () => {
    const msg = parse("privmsg #chan :hi");
    expect(msg.command).toBe("PRIVMSG");
  });

  it("parses IRCv3 tags", () => {
    const msg = parse("@time=2024-01-01T00:00:00Z;msgid=abc :nick!user@host PRIVMSG #x :y");
    expect(msg.tags?.get("time")).toBe("2024-01-01T00:00:00Z");
    expect(msg.tags?.get("msgid")).toBe("abc");
    expect(msg.command).toBe("PRIVMSG");
  });

  it("parses a tag without a value", () => {
    const msg = parse("@draft/reply :nick!u@h PRIVMSG #x :y");
    expect(msg.tags?.get("draft/reply")).toBe("");
  });

  it("strips trailing \\r\\n", () => {
    const msg = parse("PING :server\r\n");
    expect(msg.params).toEqual(["server"]);
  });

  it("returns empty command for malformed input", () => {
    const msg = parse("@tags-only");
    expect(msg.command).toBe("");
  });

  it("handles trailing param that starts with :", () => {
    const msg = parse(":s NOTICE * ::-)");
    expect(msg.params[1]).toBe(":-)");
  });
});

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

describe("build", () => {
  it("builds a PONG", () => {
    // Single-word param: no : needed (PONG irc.example.com is valid IRC)
    const line = build({ command: "PONG", params: ["irc.example.com"] });
    expect(line).toBe("PONG irc.example.com");
  });

  it("builds a PRIVMSG with space in text", () => {
    const line = build({
      prefix: "nick!user@host",
      command: "PRIVMSG",
      params: ["#chan", "hello world"],
    });
    expect(line).toBe(":nick!user@host PRIVMSG #chan :hello world");
  });

  it("adds : prefix to trailing param that starts with :", () => {
    const line = build({ command: "NOTICE", params: ["*", ":-D"] });
    expect(line).toBe("NOTICE * ::-D");
  });

  it("adds : prefix to empty trailing param", () => {
    const line = build({ command: "TOPIC", params: ["#chan", ""] });
    expect(line).toBe("TOPIC #chan :");
  });

  it("does NOT add : to non-trailing params even if they have spaces", () => {
    // Only the last param gets special treatment
    const line = build({ command: "CMD", params: ["a b", "c"] });
    // "a b" is not last, so no colon; "c" is last but has no space, no colon
    expect(line).toBe("CMD a b c");
  });

  it("builds IRCv3 tags (round-trip with space in trailing param)", () => {
    // Single-word trailing params don't need ":" — use a message with spaces
    // to verify the colon is preserved on round-trip
    const raw = "@k=v :n!u@h PRIVMSG #x :hello world";
    expect(build(parse(raw))).toBe(raw);
  });

  it("round-trips a typical server message", () => {
    const raw = ":irc.example.com 001 mynick :Welcome to IRC, mynick";
    expect(build(parse(raw))).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// extractNick()
// ---------------------------------------------------------------------------

describe("extractNick", () => {
  it("extracts nick from full prefix", () => {
    expect(extractNick("nick!user@host")).toBe("nick");
  });

  it("returns the whole string when no ! is present", () => {
    expect(extractNick("irc.example.com")).toBe("irc.example.com");
  });
});

// ---------------------------------------------------------------------------
// isChannel()
// ---------------------------------------------------------------------------

describe("isChannel", () => {
  it("recognises # channels", () => expect(isChannel("#general")).toBe(true));
  it("recognises & channels", () => expect(isChannel("&local")).toBe(true));
  it("recognises + channels", () => expect(isChannel("+moderated")).toBe(true));
  it("recognises ! channels", () => expect(isChannel("!abc")).toBe(true));
  it("rejects a plain nick", () => expect(isChannel("nick")).toBe(false));
});
