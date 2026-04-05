import { describe, expect, it } from "vitest";

import { validateMessageInput, validatePasswordInput } from "../src/input-validation";

describe("validateMessageInput", () => {
  it("allows IRC formatting control codes in message bodies", () => {
    const result = validateMessageInput("\u0002bold\u0002 \u000304green\u000f");

    expect(result).toEqual({
      ok: true,
      value: "\u0002bold\u0002 \u000304green\u000f",
    });
  });

  it("rejects CR, LF, and NUL characters", () => {
    expect(validateMessageInput("hello\rworld")).toEqual({ ok: false, error: "invalid message" });
    expect(validateMessageInput("hello\nworld")).toEqual({ ok: false, error: "invalid message" });
    expect(validateMessageInput("hello\0world")).toEqual({ ok: false, error: "invalid message" });
  });
});

describe("validatePasswordInput", () => {
  it("preserves leading and trailing spaces", () => {
    const result = validatePasswordInput(" secret ");

    expect(result).toEqual({
      ok: true,
      value: " secret ",
    });
  });
});
