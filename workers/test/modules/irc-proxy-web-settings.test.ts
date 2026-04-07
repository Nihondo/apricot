import { describe, expect, it } from "vitest";
import "./web-test-helpers";
import {
  normalizeStoredWebUiSettings,
  validateWebUiSettingsForm,
} from "../../src/irc-proxy/web-settings";
import { buildWebUiSettings } from "../../src/modules/web-theme";

function makeSettingsForm(body: string): FormData {
  return new URLSearchParams(body) as unknown as FormData;
}

describe("irc-proxy/web-settings", () => {
  it("validates form input into normalized settings", () => {
    const formData = makeSettingsForm([
      "fontFamily=test",
      "fontSizePx=14",
      "textColor=%23000000",
      "surfaceColor=%23FFFFFF",
      "surfaceAltColor=%23EEEEEE",
      "accentColor=%230000FF",
      "borderColor=%230B5FFF",
      "usernameColor=%23B00020",
      "timestampColor=%235E35B1",
      "highlightColor=%238A6D00",
      "buttonColor=%230B5FFF",
      "buttonTextColor=%23FFFFFF",
      "selfColor=%232E7D32",
      "mutedTextColor=%2375715E",
      "keywordColor=%23D84315",
      "displayOrder=asc",
      "highlightKeywords=hello",
      "dimKeywords=NickServ",
      "enableInlineUrlPreview=1",
      "extraCss=",
    ].join("&"));
    const result = validateWebUiSettingsForm(formData, buildWebUiSettings());

    expect(result.errorMessage).toBeUndefined();
    expect(result.settings).toMatchObject({
      fontFamily: "test",
      fontSizePx: 14,
      displayOrder: "asc",
      highlightKeywords: "hello",
      dimKeywords: "NickServ",
      enableInlineUrlPreview: true,
    });
  });

  it("returns a validation error for the first invalid color field", () => {
    const formData = makeSettingsForm([
      "fontFamily=test",
      "fontSizePx=14",
      "textColor=%23000000",
      "surfaceColor=%23FFFFFF",
      "surfaceAltColor=%23EEEEEE",
      "accentColor=%230000FF",
      "borderColor=blue",
      "usernameColor=%23B00020",
      "timestampColor=%235E35B1",
      "highlightColor=%238A6D00",
      "buttonColor=%230B5FFF",
      "buttonTextColor=%23FFFFFF",
      "selfColor=%232E7D32",
      "mutedTextColor=%2375715E",
      "keywordColor=%23D84315",
      "displayOrder=desc",
    ].join("&"));
    const result = validateWebUiSettingsForm(formData, buildWebUiSettings());

    expect(result.errorMessage).toBe("borderColor は #RRGGBB 形式で入力してください");
  });

  it("fills legacy stored settings from defaults and sanitizes extra css", () => {
    const settings = normalizeStoredWebUiSettings({
      fontFamily: "legacy",
      fontSizePx: 12,
      extraCss: "@import url('https://example.com/x.css'); body { color: red; }",
    });

    expect(settings.fontFamily).toBe("legacy");
    expect(settings.fontSizePx).toBe(12);
    expect(settings.textColor).toBe("#000000");
    expect(settings.extraCss).toBe("");
  });
});
