/**
 * Channel tracking module.
 * Tracks JOIN/PART/KICK/QUIT to maintain channel membership state.
 * Mirrors plum's built-in channel tracking in sn_join, sn_part, etc.
 */

import { defineModule } from "../module-system";
import { extractNick } from "../irc-parser";

/** Channel state stored per Durable Object instance */
export interface ChannelState {
  /** Original server-cased channel name (e.g. "#FooBar") */
  name: string;
  topic: string;
  members: Set<string>;
}

/**
 * Create a channel tracking module bound to a specific channelStates map.
 * Each IrcProxyDO instance should pass its own map to avoid state leakage.
 */
export function createChannelTrackModule(channelStates: Map<string, ChannelState>) {
  function ensureChannel(channel: string): ChannelState {
    const lower = channel.toLowerCase();
    let state = channelStates.get(lower);
    if (!state) {
      state = { name: channel, topic: "", members: new Set() };
      channelStates.set(lower, state);
    }
    return state;
  }

  return defineModule("channel-track", (m) => {
    // JOIN — track channel membership
    m.on("ss_join", (ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : ctx.nick;
      const channel = msg.params[0];
      const state = ensureChannel(channel);
      state.members.add(nick);

      // Update our channel list if it's us joining
      if (nick.toLowerCase() === ctx.nick.toLowerCase()) {
        if (!ctx.channels.some((ch) => ch.toLowerCase() === channel.toLowerCase())) {
          ctx.channels.push(channel); // preserve original casing from server
        }
      }
      return msg;
    });

    // PART — remove from channel
    m.on("ss_part", (ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : ctx.nick;
      const channel = msg.params[0];
      const lower = channel.toLowerCase();
      const state = channelStates.get(lower);
      if (state) {
        state.members.delete(nick);
      }
      if (nick.toLowerCase() === ctx.nick.toLowerCase()) {
        channelStates.delete(lower);
        const idx = ctx.channels.findIndex((ch) => ch.toLowerCase() === lower);
        if (idx !== -1) ctx.channels.splice(idx, 1);
      }
      return msg;
    });

    // KICK — remove kicked user
    m.on("ss_kick", (ctx, msg) => {
      const channel = msg.params[0];
      const kicked = msg.params[1];
      const lower = channel.toLowerCase();
      const state = channelStates.get(lower);
      if (state) {
        state.members.delete(kicked);
      }
      if (kicked.toLowerCase() === ctx.nick.toLowerCase()) {
        channelStates.delete(lower);
        const idx = ctx.channels.findIndex((ch) => ch.toLowerCase() === lower);
        if (idx !== -1) ctx.channels.splice(idx, 1);
      }
      return msg;
    });

    // QUIT — remove from all channels
    m.on("ss_quit", (_ctx, msg) => {
      const nick = msg.prefix ? extractNick(msg.prefix) : "";
      for (const state of channelStates.values()) {
        state.members.delete(nick);
      }
      return msg;
    });

    // NICK — update nick in all channels
    m.on("ss_nick", (_ctx, msg) => {
      const oldNick = msg.prefix ? extractNick(msg.prefix) : "";
      const newNick = msg.params[0];
      for (const state of channelStates.values()) {
        if (state.members.has(oldNick)) {
          state.members.delete(oldNick);
          state.members.add(newNick);
        }
      }
      return msg;
    });

    // 332 RPL_TOPIC — track topic
    m.on("ss_332", (_ctx, msg) => {
      const channel = msg.params[1];
      const topic = msg.params[2] || "";
      const state = ensureChannel(channel);
      state.topic = topic;
      return msg;
    });

    // TOPIC — track topic changes
    m.on("ss_topic", (_ctx, msg) => {
      const channel = msg.params[0];
      const topic = msg.params[1] || "";
      const state = ensureChannel(channel);
      state.topic = topic;
      return msg;
    });

    // 353 RPL_NAMREPLY — populate member list
    m.on("ss_353", (_ctx, msg) => {
      // params: [nick, =/*/@, #channel, "nick1 @nick2 +nick3"]
      const channel = msg.params[2];
      const state = ensureChannel(channel);
      const names = msg.params[3]?.split(" ") || [];
      for (const name of names) {
        // Strip mode prefixes (@, +, %, ~, &)
        const clean = name.replace(/^[~&@%+]+/, "");
        if (clean) state.members.add(clean);
      }
      return msg;
    });

    // Clean up on server close
    m.onServerClose((_ctx) => {
      channelStates.clear();
    });
  });
}
