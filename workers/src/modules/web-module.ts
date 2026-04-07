/**
 * IRC イベントと Web ストア/描画を結びつける module factory。
 */

import { extractNick, isChannel } from "../irc-parser";
import { defineModule } from "../module-system";
import { resolveMessageEmbed, type ResolvedUrlEmbed } from "./url-metadata";
import {
  buildChannelComposerPage,
  buildChannelListPage,
  buildChannelMessagesFragment,
  buildChannelMessagesPage,
  buildChannelPage,
  buildSettingsPage,
} from "./web-render";
import { createWebStore } from "./web-store";
import { DEFAULT_WEB_LOG_MAX_LINES, DEFAULT_WEB_UI_SETTINGS, resolveXEmbedTheme } from "./web-theme";
import type {
  ChannelLogsChangedCallback,
  ChannelMembership,
  PersistLogsCallback,
  StoredMessage,
  WebUiSettings,
} from "./web-types";

/**
 * Web UI モジュールを生成する。
 */
export function createWebModule(
  channelStates: Map<string, ChannelMembership>,
  timezoneOffset = 0,
  persistLogs?: PersistLogsCallback,
  maxLines = DEFAULT_WEB_LOG_MAX_LINES,
  onChannelLogsChanged?: ChannelLogsChangedCallback,
  enableRemoteUrlPreview = false,
  getWebUiSettings: () => WebUiSettings = () => DEFAULT_WEB_UI_SETTINGS,
) {
  const store = createWebStore({ maxLines, persistLogs, onChannelLogsChanged });

  async function buildTextMessage(
    type: "privmsg" | "notice" | "self",
    nick: string,
    text: string,
    embed?: ResolvedUrlEmbed,
    shouldResolveEmbed = false,
  ): Promise<Omit<StoredMessage, "sequence">> {
    return {
      time: Date.now(),
      type,
      nick,
      text,
      embed: embed ?? (shouldResolveEmbed
        ? await resolveMessageEmbed(text, { xTheme: resolveXEmbedTheme(getWebUiSettings().surfaceColor) })
        : undefined),
    };
  }

  const module = defineModule("web", (moduleBuilder) => {
    moduleBuilder.on("ss_privmsg", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      const text = msg.params[1] || "";
      const channel = isChannel(target) ? target : nick;
      await store.appendMessage(channel, await buildTextMessage("privmsg", nick, text, undefined, enableRemoteUrlPreview));
      return msg;
    });

    moduleBuilder.on("ss_notice", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      const text = msg.params[1] || "";
      const channel = isChannel(target) ? target : nick;
      await store.appendMessage(channel, await buildTextMessage("notice", nick, text, undefined, enableRemoteUrlPreview));
      return msg;
    });

    moduleBuilder.on("ss_join", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const channel = msg.params[0];
      await store.appendMessage(channel, { time: Date.now(), type: "join", nick, text: channel });
      return msg;
    });

    moduleBuilder.on("ss_part", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const channel = msg.params[0];
      const reason = msg.params[1] || "";
      await store.appendMessage(channel, { time: Date.now(), type: "part", nick, text: reason || channel });
      return msg;
    });

    moduleBuilder.on("ss_quit", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const reason = msg.params[0] || "";
      const entries: Array<[string, Omit<StoredMessage, "sequence">]> = [];
      for (const [, state] of channelStates) {
        if (state.members.has(nick)) {
          entries.push([state.name, { time: Date.now(), type: "quit", nick, text: reason }]);
        }
      }
      await store.appendMessages(entries);
      return msg;
    });

    moduleBuilder.on("ss_kick", async (_ctx, msg) => {
      const kicker = msg.prefix ? extractNick(msg.prefix) : "?";
      const channel = msg.params[0];
      const kicked = msg.params[1];
      const reason = msg.params[2] || "";
      await store.appendMessage(channel, {
        time: Date.now(),
        type: "kick",
        nick: kicker,
        text: `${kicker} kicked ${kicked} from ${channel} (${reason})`,
      });
      return msg;
    });

    moduleBuilder.on("ss_nick", async (_ctx, msg) => {
      const oldNick = msg.prefix ? extractNick(msg.prefix) : "?";
      const newNick = msg.params[0];
      const entries: Array<[string, Omit<StoredMessage, "sequence">]> = [];
      for (const [, state] of channelStates) {
        if (state.members.has(oldNick)) {
          entries.push([state.name, { time: Date.now(), type: "nick", nick: oldNick, text: newNick }]);
        }
      }
      await store.appendMessages(entries);
      return msg;
    });

    moduleBuilder.on("ss_topic", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const channel = msg.params[0];
      const topic = msg.params[1] || "";
      await store.appendMessage(channel, { time: Date.now(), type: "topic", nick, text: topic });
      return msg;
    });

    moduleBuilder.on("ss_mode", async (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "?";
      const target = msg.params[0];
      if (isChannel(target)) {
        await store.appendMessage(target, {
          time: Date.now(),
          type: "mode",
          nick,
          text: msg.params.slice(1).join(" "),
        });
      }
      return msg;
    });
  });

  async function recordSelfMessage(
    channel: string,
    nick: string,
    text: string,
    embed?: ResolvedUrlEmbed,
  ): Promise<void> {
    await store.appendMessage(channel, await buildTextMessage("self", nick, text, embed));
  }

  return {
    module,
    buildChannelPage(
      channel: string,
      topic: string,
      _selfNick: string,
      basePath: string,
      _showLogout = false,
      webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
      themeCssHref = "",
    ) {
      return buildChannelPage(channel, topic, basePath, webUiSettings, themeCssHref);
    },
    buildChannelMessagesPage(
      channel: string,
      topic: string,
      selfNick: string,
      webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
      channelSequence = 0,
      themeCssHref = "",
    ) {
      return buildChannelMessagesPage(
        channel,
        topic,
        store.getChannelMessages(channel),
        selfNick,
        timezoneOffset,
        webUiSettings,
        channelSequence,
        themeCssHref,
      );
    },
    buildChannelMessagesFragment(
      channel: string,
      selfNick: string,
      webUiSettings: WebUiSettings = DEFAULT_WEB_UI_SETTINGS,
      sinceSequence = 0,
    ) {
      return buildChannelMessagesFragment(
        channel,
        store.getChannelMessages(channel),
        selfNick,
        timezoneOffset,
        webUiSettings,
        sinceSequence,
      );
    },
    buildChannelComposerPage,
    buildChannelListPage,
    buildSettingsPage,
    getChannelLatestSequence: store.getChannelLatestSequence,
    getChannelLogs: store.getChannelLogs,
    getChannelTopic: store.getChannelTopic,
    hydrateLogs: store.hydrateLogs,
    recordSelfMessage,
    snapshotLogs: store.snapshotLogs,
  };
}
