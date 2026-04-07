/**
 * URL プレビューの公開 API をまとめる。
 */

import { URL_RE, X_URL_RE, isAllowedPreviewUrl } from "./url-preview-policy";
import {
  extractPageTitle,
  extractTwitterMetadata,
  resolveDirectOrRichEmbed,
} from "./url-preview-providers";
import type {
  ExtractUrlMetadataOptions,
  ResolvedUrlEmbed,
  ResolveUrlEmbedOptions,
} from "./url-preview-types";

/**
 * URL から IRC 投稿向けのメタデータ文を抽出する。
 */
export async function extractUrlMetadata(
  url: string,
  options: ExtractUrlMetadataOptions = {},
): Promise<string> {
  if (!isAllowedPreviewUrl(url)) {
    return url;
  }

  try {
    if (X_URL_RE.test(url)) {
      return await extractTwitterMetadata(url);
    }
    return await extractPageTitle(url, options.browserRendering);
  } catch {
    return url;
  }
}

/**
 * メッセージ本文に含まれる最初の埋め込み可能 URL を解決する。
 */
export async function resolveMessageEmbed(
  text: string,
  options: ResolveUrlEmbedOptions = {},
): Promise<ResolvedUrlEmbed | undefined> {
  const urls = Array.from(text.matchAll(URL_RE), (match) => match[1]);
  for (const url of urls) {
    if (!isAllowedPreviewUrl(url)) {
      continue;
    }
    const embed = await resolveUrlEmbed(url, options);
    if (embed) {
      return embed;
    }
  }
  return undefined;
}

/**
 * 1 つの URL を Web UI 用の埋め込み表現へ変換する。
 */
export async function resolveUrlEmbed(
  url: string,
  options: ResolveUrlEmbedOptions = {},
): Promise<ResolvedUrlEmbed | undefined> {
  if (!isAllowedPreviewUrl(url)) {
    return undefined;
  }

  try {
    return await resolveDirectOrRichEmbed(url, options.xTheme ?? "light");
  } catch {
    return undefined;
  }
}
