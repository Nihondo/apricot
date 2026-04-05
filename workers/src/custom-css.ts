/**
 * Sanitizes the limited custom CSS allowed for channel pages.
 */

const MAX_CUSTOM_CSS_LENGTH = 10_240;
const FORBIDDEN_CSS_TOKEN_RE = /@import|@font-face|url\s*\(|image-set\s*\(|expression\s*\(|javascript:|data:|content\s*:|behavior\s*:|-moz-binding/i;
const FORBIDDEN_SELECTOR_RE = /\*|(^|[\s>+~,(])(html|body|iframe)\b|:root/i;
const SAFE_SELECTOR_RE = /^[A-Za-z0-9_.:#,\s>+~()-]+$/;
const SAFE_VALUE_RE = /^[#(),.%/\s"'A-Za-z0-9_:+-]+$/;
const ALLOWED_SELECTOR_PREFIXES = [
  ".channel-shell",
  ".channel-shell-page",
  ".channel-messages-page",
  ".channel-composer-page",
  ".channel-messages-shell",
  ".channel-composer-shell",
  ".message-form",
  ".message-input",
  ".submit-button",
  ".channel-list-link",
  ".channel-frame",
  ".channel-topic",
  ".line",
  ".url-link",
  ".url-embed",
  ".timestamp",
  ".username-self",
  ".username-other",
  ".keyword-hl",
  ".msg-dimmed",
  ".floating",
];
const ALLOWED_PROPERTIES = new Set([
  "color",
  "background",
  "background-color",
  "border",
  "border-color",
  "border-radius",
  "box-shadow",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-decoration",
  "text-transform",
  "opacity",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "gap",
  "row-gap",
  "column-gap",
]);

type SanitizedCssResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, " ").trim();
}

function isAllowedSelector(selector: string): boolean {
  if (!SAFE_SELECTOR_RE.test(selector) || FORBIDDEN_SELECTOR_RE.test(selector)) {
    return false;
  }
  return ALLOWED_SELECTOR_PREFIXES.some((prefix) => selector.startsWith(prefix));
}

function isAllowedValue(value: string): boolean {
  return SAFE_VALUE_RE.test(value) && !FORBIDDEN_CSS_TOKEN_RE.test(value) && !/[{};@]/.test(value);
}

export function sanitizeCustomCss(input: string): SanitizedCssResult {
  if (input.length > MAX_CUSTOM_CSS_LENGTH) {
    return { ok: false, error: "Extra CSS は 10KB 以下にしてください" };
  }

  const stripped = input.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!stripped) {
    return { ok: true, value: "" };
  }
  if (FORBIDDEN_CSS_TOKEN_RE.test(stripped) || stripped.includes("@")) {
    return { ok: false, error: "Extra CSS には許可されていない構文があります" };
  }

  const blocks: string[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(stripped)) !== null) {
    if (/\S/.test(stripped.slice(cursor, match.index))) {
      return { ok: false, error: "Extra CSS の構文が不正です" };
    }
    cursor = match.index + match[0].length;

    const selectors = match[1]
      .split(",")
      .map(normalizeSelector)
      .filter(Boolean);
    if (selectors.length === 0 || selectors.some((selector) => !isAllowedSelector(selector))) {
      return { ok: false, error: "Extra CSS のセレクタが許可されていません" };
    }

    const declarations = match[2]
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (declarations.length === 0) {
      continue;
    }

    const normalizedDeclarations: string[] = [];
    for (const declaration of declarations) {
      const colonIndex = declaration.indexOf(":");
      if (colonIndex <= 0) {
        return { ok: false, error: "Extra CSS の宣言が不正です" };
      }
      const propertyName = declaration.slice(0, colonIndex).trim().toLowerCase();
      const propertyValue = declaration.slice(colonIndex + 1).trim();
      if (!ALLOWED_PROPERTIES.has(propertyName)) {
        return { ok: false, error: `Extra CSS のプロパティ ${propertyName} は許可されていません` };
      }
      if (!propertyValue || !isAllowedValue(propertyValue)) {
        return { ok: false, error: `Extra CSS の値が不正です: ${propertyName}` };
      }
      normalizedDeclarations.push(`${propertyName}: ${propertyValue};`);
    }

    blocks.push(`${selectors.join(", ")} {\n  ${normalizedDeclarations.join("\n  ")}\n}`);
  }

  if (/\S/.test(stripped.slice(cursor))) {
    return { ok: false, error: "Extra CSS の構文が不正です" };
  }

  return { ok: true, value: blocks.join("\n\n") };
}
