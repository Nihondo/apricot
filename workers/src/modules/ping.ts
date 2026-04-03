/**
 * PING/PONG handler module.
 * Responds to server PING with PONG (essential for staying connected).
 * Equivalent to plum's built-in PING handling.
 */

import { defineModule } from "../module-system";

export const pingModule = defineModule("ping", (m) => {
  m.on("ss_ping", (_ctx, msg) => {
    // Respond to server PING with PONG
    _ctx.sendToServer({
      command: "PONG",
      params: msg.params,
    });
    // Don't forward PING to clients
    return null;
  });
});
