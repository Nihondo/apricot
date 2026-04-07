/**
 * Web UI モジュールで共有する型定義。
 */

import type { ResolvedUrlEmbed } from "./url-metadata";

export interface StoredMessage {
  sequence: number;
  time: number;
  type: "privmsg" | "notice" | "join" | "part" | "quit" | "kick" | "nick" | "topic" | "mode" | "self";
  nick: string;
  text: string;
  embed?: ResolvedUrlEmbed;
}

export type PersistedStoredMessage = Omit<StoredMessage, "sequence"> & {
  sequence?: number;
};

/**
 * 永続化可能な Web ログのスナップショット。
 */
export type PersistedWebLogs = Record<string, PersistedStoredMessage[]>;

export type WebDisplayOrder = "asc" | "desc";
export type FragmentRenderMode = "full" | "delta";
export type FlashTone = "info" | "danger";

export interface RenderedChannelMessagesFragment {
  html: string;
  latestSequence: number;
  startSequence: number;
  mode: FragmentRenderMode;
}

export interface WebUiColorSettings {
  textColor: string;
  surfaceColor: string;
  surfaceAltColor: string;
  accentColor: string;
  borderColor: string;
  usernameColor: string;
  timestampColor: string;
  highlightColor: string;
  buttonColor: string;
  buttonTextColor: string;
  selfColor: string;
  mutedTextColor: string;
  keywordColor: string;
}

export interface WebUiSettings extends WebUiColorSettings {
  fontFamily: string;
  fontSizePx: number;
  displayOrder: WebDisplayOrder;
  extraCss: string;
  highlightKeywords: string;
  dimKeywords: string;
  enableInlineUrlPreview: boolean;
}

export interface ChannelMembership {
  name: string;
  members: Set<string>;
}

export type PersistLogsCallback = (logs: PersistedWebLogs) => Promise<void>;
export type ChannelLogsChangedCallback = (channels: string[]) => void;
