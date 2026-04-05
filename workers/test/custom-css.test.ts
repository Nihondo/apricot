import { describe, expect, it } from "vitest";

import { sanitizeCustomCss } from "../src/custom-css";

describe("sanitizeCustomCss", () => {
  it("allows empty rules by skipping them", () => {
    expect(sanitizeCustomCss(".channel-shell {}")).toEqual({
      ok: true,
      value: "",
    });
  });

  it("keeps valid rules when mixed with empty ones", () => {
    expect(sanitizeCustomCss(".channel-shell {} .channel-topic { color: blue; }")).toEqual({
      ok: true,
      value: ".channel-topic {\n  color: blue;\n}",
    });
  });
});
