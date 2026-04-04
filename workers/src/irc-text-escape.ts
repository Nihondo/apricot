import Encoding from "encoding-japanese";

type LegacyEncodingTarget = "JIS" | "EUCJP" | "SJIS";

const legacyEncodingTargets: Record<string, LegacyEncodingTarget> = {
  "iso-2022-jp": "JIS",
  "euc-jp": "EUCJP",
  "shift_jis": "SJIS",
  "shift-jis": "SJIS",
};

function resolveLegacyEncodingTarget(encoding?: string): LegacyEncodingTarget | null {
  const normalizedEncoding = encoding?.toLowerCase();
  if (!normalizedEncoding || normalizedEncoding === "utf-8" || normalizedEncoding === "utf8") {
    return null;
  }
  return legacyEncodingTargets[normalizedEncoding] ?? "JIS";
}

function encodeAsHtmlEntity(char: string): string {
  const codePoint = char.codePointAt(0);
  return codePoint === undefined ? char : `&#x${codePoint.toString(16).toUpperCase()};`;
}

function canRoundTripCharacter(char: string, target: LegacyEncodingTarget): boolean {
  const unicodeCodes = Encoding.stringToCode(char);
  const encodedCodes = Encoding.convert(unicodeCodes, { to: target, from: "UNICODE" });
  const decodedChar = Encoding.codeToString(
    Encoding.convert(encodedCodes, { to: "UNICODE", from: target })
  );
  return decodedChar === char;
}

/**
 * Escapes characters that cannot be represented in the configured IRC server encoding.
 */
export function escapeUnsupportedIrcText(text: string, encoding?: string): string {
  const target = resolveLegacyEncodingTarget(encoding);
  if (!target) {
    return text;
  }

  return Array.from(text)
    .map((char) => canRoundTripCharacter(char, target) ? char : encodeAsHtmlEntity(char))
    .join("");
}
