/**
 * Web UI モジュールの公開エントリポイント。
 */

export {
  buildChannelListPage,
  buildSettingsPage,
} from "./web-render";
export { createWebModule } from "./web-module";
export {
  buildAdminCss,
  buildChannelCss,
  buildCustomThemeCss,
  buildWebAppHead,
  buildWebUiSettings,
  DARK_WEB_UI_COLOR_PRESET,
  DEFAULT_WEB_UI_SETTINGS,
  LIGHT_WEB_UI_COLOR_PRESET,
  isWebDisplayOrder,
  resolveXEmbedTheme,
  sanitizeStoredCustomCss,
  WEB_UI_COLOR_FIELDS,
} from "./web-theme";
export type {
  ChannelMembership,
  ChannelLogsChangedCallback,
  FlashTone,
  PersistedStoredMessage,
  PersistedWebLogs,
  PersistLogsCallback,
  RenderedChannelMessagesFragment,
  StoredMessage,
  WebDisplayOrder,
  WebUiColorSettings,
  WebUiSettings,
} from "./web-types";
