/**
 * Client sync module.
 * When a new client connects, replays the current proxy state:
 * - Send 001 welcome
 * - Replay channel JOINs, TOPICs, and NAMES
 *
 * Mirrors plum's c_init() behavior.
 */

import { defineModule } from "../module-system";
import type { ChannelState } from "./channel-track";

/**
 * Create a client sync module bound to a specific channelStates map.
 */
export function createClientSyncModule(channelStates: Map<string, ChannelState>) {
  return defineModule("client-sync", (m) => {
    m.onClientOpen((ctx) => {
      // Send RPL_WELCOME
      ctx.sendToClients({
        prefix: ctx.serverName || "apricot",
        command: "001",
        params: [ctx.nick, `Welcome to IRC via apricot, ${ctx.nick}`],
      });

      // Send RPL_YOURHOST
      ctx.sendToClients({
        prefix: ctx.serverName || "apricot",
        command: "002",
        params: [ctx.nick, `Your host is apricot, running on Cloudflare Workers`],
      });

      // Replay channel state using original-cased name from ChannelState
      for (const [, state] of channelStates) {
        const channel = state.name;

        // Send JOIN
        ctx.sendToClients({
          prefix: `${ctx.nick}!proxy@apricot`,
          command: "JOIN",
          params: [channel],
        });

        // Send TOPIC if set
        if (state.topic) {
          ctx.sendToClients({
            prefix: ctx.serverName || "apricot",
            command: "332",
            params: [ctx.nick, channel, state.topic],
          });
        }

        // Send NAMES list
        if (state.members.size > 0) {
          const names = Array.from(state.members).join(" ");
          ctx.sendToClients({
            prefix: ctx.serverName || "apricot",
            command: "353",
            params: [ctx.nick, "=", channel, names],
          });
          ctx.sendToClients({
            prefix: ctx.serverName || "apricot",
            command: "366",
            params: [ctx.nick, channel, "End of /NAMES list"],
          });
        }
      }
    });
  });
}
