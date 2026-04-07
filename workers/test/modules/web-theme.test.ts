import { describe, expect, it } from "vitest";
import "./web-test-helpers";
import {
  buildAdminCss,
  buildChannelCss,
  buildCustomThemeCss,
  buildWebUiSettings,
} from "../../src/modules/web-theme";

describe("web-theme", () => {
  it("builds channel CSS without appending custom CSS inline", () => {
    const css = buildChannelCss(buildWebUiSettings({
      fontFamily: "\"Fira Sans\", sans-serif",
      fontSizePx: 18,
      textColor: "#123456",
      surfaceColor: "#ABCDEF",
      surfaceAltColor: "#FEDCBA",
      accentColor: "#A6E22E",
      borderColor: "#0F0F0F",
      usernameColor: "#AA5500",
      timestampColor: "#00AA55",
      highlightColor: "#998800",
      buttonColor: "#001122",
      buttonTextColor: "#F0F0F0",
      selfColor: "#00CCFF",
      mutedTextColor: "#666666",
      keywordColor: "#FF4400",
      extraCss: ".custom { color: red; }",
    }));

    expect(css).toContain("font-family: \"Fira Sans\", sans-serif;");
    expect(css).toContain("font-size: 18px;");
    expect(css).toContain("--textcolor: #123456;");
    expect(css).toContain("--border-color: #0F0F0F;");
    expect(css).toContain("--button-bg: #001122;");
    expect(css).toContain("--button-fg: #F0F0F0;");
    expect(css).toContain("--text-contrast-low: #666666;");
    expect(css).toContain("--link-bg: rgba(166,226,46,0.2);");
    expect(css).toContain("--accent-keyword: #FF4400;");
    expect(css).not.toContain(".custom { color: red; }");
  });

  it("builds custom theme CSS separately", () => {
    const css = buildCustomThemeCss(buildWebUiSettings({
      extraCss: ".custom { color: red; }",
    }));

    expect(css).toBe(".custom { color: red; }");
  });

  it("builds fixed admin CSS separately from channel customization", () => {
    expect(buildAdminCss()).toBe("ADMIN_CSS");
  });
});
