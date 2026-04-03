/**
 * Module system for the IRC proxy.
 * Mirrors plum's event-driven module architecture.
 *
 * Event naming convention (same as plum):
 *   ss_<cmd> — server scan: message received from IRC server
 *   cs_<cmd> — client scan: message received from IRC client
 *   server_open / server_close — server connection lifecycle
 *   client_open / client_close — client connection lifecycle
 *   main_loop — periodic maintenance
 */

import type { IrcMessage } from "./irc-parser";

export type EventResult = IrcMessage | null;

export type EventHandler = (
  ctx: ModuleContext,
  msg: IrcMessage
) => EventResult | Promise<EventResult>;

export type LifecycleHandler = (ctx: ModuleContext) => void | Promise<void>;

export interface ModuleContext {
  /** User number (proxy session identifier) */
  userno: number;
  /** Connection number (server or client fd equivalent) */
  connno: number;
  /** Send a message to the IRC server */
  sendToServer: (msg: IrcMessage) => Promise<void>;
  /** Send a message to all connected clients */
  sendToClients: (msg: IrcMessage) => void;
  /** Get a module property from config */
  getProperty: (key: string) => string | undefined;
  /** Current nickname on the server */
  nick: string;
  /** List of joined channels */
  channels: string[];
  /** Server name */
  serverName: string;
}

export interface PlumModule {
  name: string;
  /** Event handlers keyed by event name (ss_privmsg, cs_join, etc.) */
  handlers: Map<string, EventHandler>;
  /** Lifecycle handlers */
  onEnable?: LifecycleHandler;
  onDisable?: LifecycleHandler;
  onServerOpen?: LifecycleHandler;
  onServerClose?: LifecycleHandler;
  onClientOpen?: LifecycleHandler;
  onClientClose?: LifecycleHandler;
}

/**
 * Module registry — manages loaded modules and dispatches events.
 */
export class ModuleRegistry {
  private modules: PlumModule[] = [];

  register(mod: PlumModule): void {
    this.modules.push(mod);
  }

  /**
   * Dispatch a scan event through all modules (forward order).
   * Like plum's scan_event: each module can modify or drop the message.
   * Returns null if any module drops the message.
   */
  async dispatchScan(event: string, ctx: ModuleContext, msg: IrcMessage): Promise<EventResult> {
    let current: IrcMessage | null = msg;
    for (const mod of this.modules) {
      const handler = mod.handlers.get(event);
      if (!handler) continue;
      if (!current) return null; // Message was dropped earlier
      current = await handler(ctx, current);
      if (!current) return null; // Module dropped the message
    }
    return current;
  }

  /**
   * Dispatch a lifecycle event to all modules.
   */
  async dispatchLifecycle(
    event: "onEnable" | "onDisable" | "onServerOpen" | "onServerClose" | "onClientOpen" | "onClientClose",
    ctx: ModuleContext
  ): Promise<void> {
    for (const mod of this.modules) {
      const handler = mod[event];
      if (handler) {
        await handler(ctx);
      }
    }
  }

  getModules(): readonly PlumModule[] {
    return this.modules;
  }
}

/**
 * Helper to define a module concisely.
 */
export function defineModule(
  name: string,
  setup: (m: ModuleBuilder) => void
): PlumModule {
  const builder = new ModuleBuilder(name);
  setup(builder);
  return builder.build();
}

class ModuleBuilder {
  private mod: PlumModule;

  constructor(name: string) {
    this.mod = { name, handlers: new Map() };
  }

  on(event: string, handler: EventHandler): this {
    this.mod.handlers.set(event, handler);
    return this;
  }

  onEnable(handler: LifecycleHandler): this {
    this.mod.onEnable = handler;
    return this;
  }

  onServerOpen(handler: LifecycleHandler): this {
    this.mod.onServerOpen = handler;
    return this;
  }

  onServerClose(handler: LifecycleHandler): this {
    this.mod.onServerClose = handler;
    return this;
  }

  onClientOpen(handler: LifecycleHandler): this {
    this.mod.onClientOpen = handler;
    return this;
  }

  onClientClose(handler: LifecycleHandler): this {
    this.mod.onClientClose = handler;
    return this;
  }

  build(): PlumModule {
    return this.mod;
  }
}
