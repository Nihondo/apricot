import { describe, expect, it } from "vitest";

import { escapeUnsupportedIrcText } from "./irc-text-escape";

describe("escapeUnsupportedIrcText", () => {
  it("keeps utf-8 text unchanged", () => {
    expect(escapeUnsupportedIrcText("hello😀", "utf-8")).toBe("hello😀");
  });

  it("keeps representable characters unchanged in non-utf8 encodings", () => {
    expect(escapeUnsupportedIrcText("helloあ①", "iso-2022-jp")).toBe("helloあ①");
  });

  it("escapes unrepresentable characters in non-utf8 encodings", () => {
    expect(escapeUnsupportedIrcText("hello😀𠮷", "iso-2022-jp")).toBe("hello&#x1F600;&#x20BB7;");
  });

  it("uses escape mode for non-utf8 encodings other than utf-8 aliases", () => {
    expect(escapeUnsupportedIrcText("hi😀", "shift_jis")).toBe("hi&#x1F600;");
  });
});
