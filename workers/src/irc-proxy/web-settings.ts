/**
 * Web UI 設定の検証と正規化。
 */

import { sanitizeCustomCss } from "../custom-css";
import {
  buildWebUiSettings,
  DEFAULT_WEB_UI_SETTINGS,
  isWebDisplayOrder,
  LIGHT_WEB_UI_COLOR_PRESET,
  sanitizeStoredCustomCss,
  WEB_UI_COLOR_FIELDS,
} from "../modules/web";
import type { WebUiColorSettings, WebUiSettings } from "../modules/web";

export const webUiColorFieldNames: Array<keyof WebUiColorSettings> = WEB_UI_COLOR_FIELDS.map(({ name }) => name);

/**
 * 設定フォーム入力を検証し、保存可能な Web UI 設定へ変換する。
 */
export function validateWebUiSettingsForm(
  formData: FormData,
  currentSettings: WebUiSettings,
): {
  settings: WebUiSettings;
  errorMessage?: string;
} {
  const draftSettings: WebUiSettings = { ...currentSettings };
  const fontFamily = (formData.get("fontFamily") as string | null)?.trim() ?? "";
  if (!fontFamily || fontFamily.length > 200) {
    return {
      settings: { ...draftSettings, fontFamily: fontFamily || draftSettings.fontFamily },
      errorMessage: "Font family は 1〜200 文字で入力してください",
    };
  }
  draftSettings.fontFamily = fontFamily;

  const fontSizeRaw = (formData.get("fontSizePx") as string | null)?.trim() ?? "";
  const fontSizePx = Number.parseInt(fontSizeRaw, 10);
  if (!Number.isInteger(fontSizePx) || fontSizePx < 10 || fontSizePx > 32) {
    return {
      settings: { ...draftSettings },
      errorMessage: "Font size は 10〜32 の整数で入力してください",
    };
  }
  draftSettings.fontSizePx = fontSizePx;

  for (const fieldName of webUiColorFieldNames) {
    const colorValue = (formData.get(fieldName) as string | null)?.trim() ?? "";
    if (!/^#[0-9A-Fa-f]{6}$/.test(colorValue)) {
      return {
        settings: { ...draftSettings },
        errorMessage: `${fieldName} は #RRGGBB 形式で入力してください`,
      };
    }
    draftSettings[fieldName] = colorValue;
  }

  const displayOrder = (formData.get("displayOrder") as string | null)?.trim() ?? "";
  if (!isWebDisplayOrder(displayOrder)) {
    return {
      settings: { ...draftSettings },
      errorMessage: "Display order は asc または desc を指定してください",
    };
  }
  draftSettings.displayOrder = displayOrder;

  const extraCss = (formData.get("extraCss") as string | null) ?? "";
  const customCssResult = sanitizeCustomCss(extraCss);
  if (!customCssResult.ok) {
    return {
      settings: { ...draftSettings },
      errorMessage: customCssResult.error,
    };
  }
  draftSettings.extraCss = customCssResult.value;

  const highlightKeywords = (formData.get("highlightKeywords") as string | null) ?? "";
  if (highlightKeywords.length > 2048) {
    return {
      settings: { ...draftSettings },
      errorMessage: "キーワード強調は 2KB 以下にしてください",
    };
  }
  draftSettings.highlightKeywords = highlightKeywords;

  const dimKeywords = (formData.get("dimKeywords") as string | null) ?? "";
  if (dimKeywords.length > 2048) {
    return {
      settings: { ...draftSettings },
      errorMessage: "キーワードDIMは 2KB 以下にしてください",
    };
  }
  draftSettings.dimKeywords = dimKeywords;
  draftSettings.enableInlineUrlPreview = formData.get("enableInlineUrlPreview") !== null;

  return {
    settings: buildWebUiSettings(draftSettings),
  };
}

/**
 * 永続化済み設定を現在のスキーマへ正規化する。
 */
export function normalizeStoredWebUiSettings(stored?: Partial<WebUiSettings>): WebUiSettings {
  if (!stored) {
    return { ...DEFAULT_WEB_UI_SETTINGS };
  }

  const isValidColor = (value: string | undefined): value is string => (
    typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value)
  );
  const fontFamily = typeof stored.fontFamily === "string" && stored.fontFamily.trim() && stored.fontFamily.length <= 200
    ? stored.fontFamily.trim()
    : DEFAULT_WEB_UI_SETTINGS.fontFamily;
  const storedFontSizePx = stored.fontSizePx;
  const fontSizePx = typeof storedFontSizePx === "number"
    && Number.isInteger(storedFontSizePx)
    && storedFontSizePx >= 10
    && storedFontSizePx <= 32
    ? storedFontSizePx
    : DEFAULT_WEB_UI_SETTINGS.fontSizePx;
  const displayOrder = stored.displayOrder && isWebDisplayOrder(stored.displayOrder)
    ? stored.displayOrder
    : DEFAULT_WEB_UI_SETTINGS.displayOrder;
  const extraCss = typeof stored.extraCss === "string"
    ? sanitizeStoredCustomCss(stored.extraCss)
    : DEFAULT_WEB_UI_SETTINGS.extraCss;
  const highlightKeywords = typeof stored.highlightKeywords === "string" && stored.highlightKeywords.length <= 2048
    ? stored.highlightKeywords
    : DEFAULT_WEB_UI_SETTINGS.highlightKeywords;
  const dimKeywords = typeof stored.dimKeywords === "string" && stored.dimKeywords.length <= 2048
    ? stored.dimKeywords
    : DEFAULT_WEB_UI_SETTINGS.dimKeywords;
  const enableInlineUrlPreview = typeof stored.enableInlineUrlPreview === "boolean"
    ? stored.enableInlineUrlPreview
    : DEFAULT_WEB_UI_SETTINGS.enableInlineUrlPreview;

  return buildWebUiSettings({
    fontFamily,
    fontSizePx,
    textColor: isValidColor(stored.textColor) ? stored.textColor : LIGHT_WEB_UI_COLOR_PRESET.textColor,
    surfaceColor: isValidColor(stored.surfaceColor) ? stored.surfaceColor : LIGHT_WEB_UI_COLOR_PRESET.surfaceColor,
    surfaceAltColor: isValidColor(stored.surfaceAltColor) ? stored.surfaceAltColor : LIGHT_WEB_UI_COLOR_PRESET.surfaceAltColor,
    accentColor: isValidColor(stored.accentColor) ? stored.accentColor : LIGHT_WEB_UI_COLOR_PRESET.accentColor,
    borderColor: isValidColor(stored.borderColor) ? stored.borderColor : LIGHT_WEB_UI_COLOR_PRESET.borderColor,
    usernameColor: isValidColor(stored.usernameColor) ? stored.usernameColor : LIGHT_WEB_UI_COLOR_PRESET.usernameColor,
    timestampColor: isValidColor(stored.timestampColor) ? stored.timestampColor : LIGHT_WEB_UI_COLOR_PRESET.timestampColor,
    highlightColor: isValidColor(stored.highlightColor) ? stored.highlightColor : LIGHT_WEB_UI_COLOR_PRESET.highlightColor,
    buttonColor: isValidColor(stored.buttonColor) ? stored.buttonColor : LIGHT_WEB_UI_COLOR_PRESET.buttonColor,
    buttonTextColor: isValidColor(stored.buttonTextColor) ? stored.buttonTextColor : LIGHT_WEB_UI_COLOR_PRESET.buttonTextColor,
    selfColor: isValidColor(stored.selfColor) ? stored.selfColor : LIGHT_WEB_UI_COLOR_PRESET.selfColor,
    mutedTextColor: isValidColor(stored.mutedTextColor) ? stored.mutedTextColor : LIGHT_WEB_UI_COLOR_PRESET.mutedTextColor,
    keywordColor: isValidColor(stored.keywordColor) ? stored.keywordColor : LIGHT_WEB_UI_COLOR_PRESET.keywordColor,
    displayOrder,
    extraCss,
    highlightKeywords,
    dimKeywords,
    enableInlineUrlPreview,
  });
}
