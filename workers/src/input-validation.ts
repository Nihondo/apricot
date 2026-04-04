/**
 * Shared input validation for external-facing IRC operations.
 */

const IRC_CONTROL_CHAR_RE = /[\0-\x1F\x7F]/;
const IRC_LINE_BREAK_RE = /[\r\n\0]/;

type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

function normalizeInput(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasForbiddenControlChars(value: string): boolean {
  return IRC_CONTROL_CHAR_RE.test(value);
}

export function hasForbiddenLineBreaks(value: string): boolean {
  return IRC_LINE_BREAK_RE.test(value);
}

export function validateChannelInput(value: string | null | undefined): ValidationResult {
  const normalized = normalizeInput(value);
  if (!normalized) {
    return { ok: false, error: "missing channel" };
  }
  if (!normalized.startsWith("#") && !normalized.startsWith("&")) {
    return { ok: false, error: "invalid channel" };
  }
  if (/\s|,/.test(normalized) || hasForbiddenControlChars(normalized)) {
    return { ok: false, error: "invalid channel" };
  }
  return { ok: true, value: normalized };
}

export function validateNickInput(value: string | null | undefined): ValidationResult {
  const normalized = normalizeInput(value);
  if (!normalized) {
    return { ok: false, error: "missing nick" };
  }
  if (/\s|:/.test(normalized) || hasForbiddenControlChars(normalized)) {
    return { ok: false, error: "invalid nick" };
  }
  return { ok: true, value: normalized };
}

export function validateMessageInput(value: string | null | undefined): ValidationResult {
  const normalized = normalizeInput(value);
  if (!normalized) {
    return { ok: false, error: "missing message" };
  }
  if (hasForbiddenControlChars(normalized)) {
    return { ok: false, error: "invalid message" };
  }
  return { ok: true, value: normalized };
}

export function validatePasswordInput(value: string | null | undefined): ValidationResult {
  const normalized = typeof value === "string" ? value : "";
  if (hasForbiddenControlChars(normalized)) {
    return { ok: false, error: "invalid password" };
  }
  return { ok: true, value: normalized };
}
