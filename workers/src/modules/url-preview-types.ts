/**
 * URL プレビュー解決で共有する型定義。
 */

export type XEmbedTheme = "light" | "dark";

export interface ResolvedUrlEmbed {
  kind: "image" | "card" | "rich";
  sourceUrl: string;
  imageUrl?: string;
  title?: string;
  siteName?: string;
  description?: string;
  html?: string;
}

interface OEmbedPayload {
  title?: string;
  provider_name?: string;
  thumbnail_url?: string;
  url?: string;
  type?: string;
  author_name?: string;
  html?: string;
}

interface HtmlMetadata {
  html: string;
  finalUrl: string;
}

interface YouTubeEmbedInfo {
  videoId: string;
  isShort: boolean;
}

/**
 * Cloudflare Browser Rendering の認証情報。
 */
export interface BrowserRenderingConfig {
  accountId: string;
  apiToken: string;
}

/**
 * URL タイトル抽出時のオプション。
 */
export interface ExtractUrlMetadataOptions {
  browserRendering?: BrowserRenderingConfig;
}

export interface ResolveUrlEmbedOptions {
  xTheme?: XEmbedTheme;
}

export interface BrowserRenderingScrapeResponse {
  result?: Array<{
    selector?: string;
    results?: Array<{
      text?: string;
    }>;
  }>;
}

export type {
  HtmlMetadata,
  OEmbedPayload,
  YouTubeEmbedInfo,
};
