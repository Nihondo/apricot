/**
 * Web UI の配色、フォント、CSS 生成を扱う。
 */

import CSS from "../templates/style.css";
import ADMIN_CSS from "../templates/admin-style.css";
import { sanitizeCustomCss } from "../custom-css";
import type { XEmbedTheme } from "./url-metadata";
import type { WebDisplayOrder, WebUiColorSettings, WebUiSettings } from "./web-types";

const X_EMBED_DARK_THEME_LUMINANCE_THRESHOLD = 128;

export const DEFAULT_WEB_LOG_MAX_LINES = 200;

export const LIGHT_WEB_UI_COLOR_PRESET: WebUiColorSettings = {
  textColor: "#000000",
  surfaceColor: "#FFFFFF",
  surfaceAltColor: "#EDF3FE",
  accentColor: "#0B5FFF",
  borderColor: "#0B5FFF",
  usernameColor: "#B00020",
  timestampColor: "#5E35B1",
  highlightColor: "#8A6D00",
  buttonColor: "#0B5FFF",
  buttonTextColor: "#FFFFFF",
  selfColor: "#2E7D32",
  mutedTextColor: "#75715E",
  keywordColor: "#D84315",
};

export const DARK_WEB_UI_COLOR_PRESET: WebUiColorSettings = {
  textColor: "#F8F8F2",
  surfaceColor: "#1F2023",
  surfaceAltColor: "#2A2B2E",
  accentColor: "#A6E22E",
  borderColor: "#2B8BF7",
  usernameColor: "#F92672",
  timestampColor: "#AE81FF",
  highlightColor: "#E6DB74",
  buttonColor: "#2B8BF7",
  buttonTextColor: "#FFFFFF",
  selfColor: "#66D9EF",
  mutedTextColor: "#75715E",
  keywordColor: "#FD971F",
};

export const DEFAULT_WEB_UI_SETTINGS: WebUiSettings = {
  fontFamily: "\"Hiragino Kaku Gothic ProN\", \"Noto Sans JP\", sans-serif",
  fontSizePx: 16,
  ...LIGHT_WEB_UI_COLOR_PRESET,
  displayOrder: "desc",
  extraCss: "",
  highlightKeywords: "",
  dimKeywords: "",
  enableInlineUrlPreview: false,
};

export const WEB_UI_COLOR_FIELDS = [
  { name: "textColor", label: "文字色" },
  { name: "surfaceColor", label: "背景色1" },
  { name: "surfaceAltColor", label: "背景色2" },
  { name: "accentColor", label: "リンク" },
  { name: "borderColor", label: "枠線" },
  { name: "usernameColor", label: "他ユーザ名" },
  { name: "timestampColor", label: "時刻" },
  { name: "highlightColor", label: "リンク行" },
  { name: "buttonColor", label: "ボタン" },
  { name: "buttonTextColor", label: "ボタン文字" },
  { name: "selfColor", label: "自ユーザ名" },
  { name: "mutedTextColor", label: "非強調色" },
  { name: "keywordColor", label: "キーワード" },
] as const satisfies ReadonlyArray<{ name: keyof WebUiColorSettings; label: string }>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildLinkBackgroundColor(accentColor: string): string {
  const red = Number.parseInt(accentColor.slice(1, 3), 16);
  const green = Number.parseInt(accentColor.slice(3, 5), 16);
  const blue = Number.parseInt(accentColor.slice(5, 7), 16);
  return `rgba(${red},${green},${blue},0.2)`;
}

function normalizeHexColor(color: string): string | undefined {
  const normalized = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return normalized;
  }
  if (!/^#[0-9a-fA-F]{3}$/.test(normalized)) {
    return undefined;
  }
  return `#${normalized.slice(1).split("").map((part) => `${part}${part}`).join("")}`;
}

/**
 * 背景色から X 埋め込みの theme を決定する。
 */
export function resolveXEmbedTheme(surfaceColor: string): XEmbedTheme {
  const normalized = normalizeHexColor(surfaceColor);
  if (!normalized) {
    return "light";
  }

  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return luminance < X_EMBED_DARK_THEME_LUMINANCE_THRESHOLD ? "dark" : "light";
}

/**
 * 既定値を補った Web UI 設定を返す。
 */
export function buildWebUiSettings(overrides?: Partial<WebUiSettings> | null): WebUiSettings {
  return {
    ...DEFAULT_WEB_UI_SETTINGS,
    ...overrides,
  };
}

/**
 * 表示順の値が有効かを判定する。
 */
export function isWebDisplayOrder(value: string): value is WebDisplayOrder {
  return value === "asc" || value === "desc";
}

/**
 * 管理画面向けの固定 CSS を返す。
 */
export function buildAdminCss(): string {
  return ADMIN_CSS;
}

/**
 * チャンネル画面向けの CSS を組み立てる。
 */
export function buildChannelCss(settings: WebUiSettings): string {
  const rootLines = [
    `--rowcolor0: ${settings.surfaceColor};`,
    `--rowcolor1: ${settings.surfaceAltColor};`,
    `--textcolor: ${settings.textColor};`,
    `--accent-link: ${settings.accentColor};`,
    `--link-bg: ${buildLinkBackgroundColor(settings.accentColor)};`,
    `--border-color: ${settings.borderColor};`,
    `--accent-username: ${settings.usernameColor};`,
    `--accent-timestamp: ${settings.timestampColor};`,
    `--accent-highlight: ${settings.highlightColor};`,
    `--button-bg: ${settings.buttonColor};`,
    `--button-fg: ${settings.buttonTextColor};`,
    `--accent-self: ${settings.selfColor};`,
    `--text-contrast-low: ${settings.mutedTextColor};`,
    `--accent-keyword: ${settings.keywordColor};`,
  ];
  const typographyLines = [
    `font-family: ${settings.fontFamily};`,
    `font-size: ${settings.fontSizePx}px;`,
  ];

  return [
    CSS,
    `:root {\n  ${rootLines.join("\n  ")}\n}`,
    `body,\ninput,\nbutton,\ntextarea {\n  ${typographyLines.join("\n  ")}\n}`,
  ].join("\n\n");
}

/**
 * ユーザー指定の追加 CSS を返す。
 */
export function buildCustomThemeCss(settings: WebUiSettings): string {
  return settings.extraCss.trim();
}

/**
 * 永続化済みの追加 CSS を安全に復元する。
 */
export function sanitizeStoredCustomCss(extraCss: string): string {
  const result = sanitizeCustomCss(extraCss);
  return result.ok ? result.value : "";
}

/**
 * Web アプリ向けの `<head>` 断片を返す。
 */
export function buildWebAppHead(basePath: string, themeColor: string, appTitle = "apricot"): string {
  const manifestUrl = `${basePath}/manifest.webmanifest`;
  const appIconUrl = `${basePath}/assets/app-icon.png`;
  return [
    `<link rel="manifest" href="${escapeHtml(manifestUrl)}">`,
    `<link rel="apple-touch-icon" href="${escapeHtml(appIconUrl)}">`,
    `<meta name="theme-color" content="${escapeHtml(themeColor)}">`,
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    `<meta name="apple-mobile-web-app-title" content="${escapeHtml(appTitle)}">`,
  ].join("\n");
}
