import { vi } from "vitest";
import type { ModuleContext } from "../../src/module-system";

const hoistedMocks = vi.hoisted(() => ({
  resolveMessageEmbedMock: vi.fn(),
}));
export const resolveMessageEmbedMock = hoistedMocks.resolveMessageEmbedMock;

vi.mock("../../src/templates/admin-style.css", () => ({ default: "ADMIN_CSS" }));
vi.mock("../../src/templates/style.css", () => ({ default: "" }));
vi.mock("../../src/modules/url-metadata", () => ({
  resolveMessageEmbed: resolveMessageEmbedMock,
}));
vi.mock("../../src/templates/channel.html", () => ({
  default: "<html><head><style>{{CSS}}</style>{{THEME_CSS_LINK}}</head><body><div class=\"shell\">{{FRAME_CONTENT}}</div></body></html>",
}));
vi.mock("../../src/templates/channel-messages.html", () => ({
  default: "<html><head><style>{{CSS}}</style>{{THEME_CSS_LINK}}<script>{{AUTO_SCROLL_SCRIPT}}</script></head><body><div id=\"channel-messages-shell\">{{MESSAGES}}</div>{{RELOAD_BUTTON}}</body></html>",
}));
vi.mock("../../src/templates/channel-composer.html", () => ({
  default: "<html><head><style>{{CSS}}</style>{{THEME_CSS_LINK}}<script>{{ON_LOAD_SCRIPT}}</script></head><body>{{FLASH_MESSAGE}}<form action=\"{{ACTION_URL}}\">{{CHANNEL_LIST_LINK}}<input name=\"message\" value=\"{{MESSAGE_VALUE}}\"><button>送信</button></form></body></html>",
}));
vi.mock("../../src/templates/channel-list.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}<p>{{SERVER_NAME}} に {{NICK}} として参加</p>{{FLASH_MESSAGE}}{{NICK_FORM}}<div>{{STATUS_CLASS}}{{STATUS_TEXT}}{{CHANNEL_COUNT}}{{CHANNEL_LINKS}}</div>{{CONFIG_PANEL}}<span>サーバー: {{SERVER_NAME}}</span><span>NICK: {{NICK}}</span></body></html>",
}));
vi.mock("../../src/templates/settings.html", () => ({
  default: "<html><head><style>{{CSS}}</style></head><body>{{TOP_ACTIONS}}{{ERROR}}この設定はチャンネル画面にのみ適用されます。<form action=\"{{ACTION_URL}}\">{{COLOR_PREVIEW}}<input name=\"fontFamily\" value=\"{{FONT_FAMILY}}\"><input name=\"fontSizePx\" value=\"{{FONT_SIZE_PX}}\">{{PRESET_CONTROLS}}{{COLOR_FIELDS}}<input type=\"checkbox\" name=\"enableInlineUrlPreview\" {{ENABLE_INLINE_URL_PREVIEW_CHECKED}}><textarea name=\"highlightKeywords\">{{HIGHLIGHT_KEYWORDS}}</textarea><textarea name=\"dimKeywords\">{{DIM_KEYWORDS}}</textarea><textarea>{{EXTRA_CSS}}</textarea>{{DISPLAY_ORDER_ASC_CHECKED}}{{DISPLAY_ORDER_DESC_CHECKED}}</form>{{SETTINGS_SCRIPT}}</body></html>",
}));

export function makeContext(overrides: Partial<ModuleContext> = {}): ModuleContext {
  return {
    userno: 0,
    connno: 0,
    sendToServer: async () => undefined,
    sendToClients: () => undefined,
    getProperty: () => undefined,
    nick: "apricot",
    channels: [],
    serverName: "irc.example.com",
    ...overrides,
  };
}
