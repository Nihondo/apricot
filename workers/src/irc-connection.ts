/**
 * IRC server connection via Cloudflare Workers TCP sockets.
 * Uses the cloudflare:sockets API to maintain a persistent TCP connection
 * to an IRC server.
 */

import { connect } from "cloudflare:sockets";
import { parse, build, type IrcMessage } from "./irc-parser";
import Encoding from "encoding-japanese";

export interface IrcServerConfig {
  host: string;
  port: number;
  password?: string;
  nick: string;
  user: string;
  realname: string;
  tls?: boolean;
  encoding?: string; // e.g. "iso-2022-jp", "euc-jp", "shift_jis" (default: utf-8)
}

export interface IrcServerConnectionOptions {
  connectTimeoutMs?: number;
}

export type MessageCallback = (msg: IrcMessage) => void | Promise<void>;
export type CloseCallback = () => void | Promise<void>;

export class IrcServerConnection {
  private socket: Socket | null = null;
  private writer: WritableStreamDefaultWriter | null = null;
  private utf8Encoder = new TextEncoder();
  private buffer = "";
  private onMessage: MessageCallback;
  private onClose: CloseCallback;
  private config: IrcServerConfig;
  private options: IrcServerConnectionOptions;
  private _connected = false;
  private isClosed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    config: IrcServerConfig,
    onMessage: MessageCallback,
    onClose: CloseCallback,
    options: IrcServerConnectionOptions = {}
  ) {
    this.config = config;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.options = options;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    const address: SocketAddress = {
      hostname: this.config.host,
      port: this.config.port,
    };

    const options: SocketOptions = {
      allowHalfOpen: false,
    };
    if (this.config.tls) {
      options.secureTransport = "on";
    }

    console.log(`IRC: connecting to ${address.hostname}:${address.port} (tls=${!!this.config.tls})`);
    this.socket = connect(address, options);
    this.writer = this.socket.writable.getWriter();
    this.isClosed = false;
    this.closePromise = null;
    this.buffer = "";

    void this.socket.closed
      .catch((error) => {
        console.error("IRC socket closed with error", error);
      })
      .finally(() => {
        void this.finalizeClose();
      });

    await this.waitForSocketOpen(this.socket);

    // Start reading in background
    void this.readLoop().catch((error) => {
      console.error("IRC read loop failed", error);
      void this.finalizeClose();
    });

    // IRC registration sequence
    if (this.config.password) {
      await this.sendRaw(`PASS ${this.config.password}`);
    }
    await this.sendRaw(`NICK ${this.config.nick}`);
    await this.sendRaw(
      `USER ${this.config.user} 0 * :${this.config.realname}`
    );
  }

  /**
   * Waits until the outbound TCP socket is opened or times out.
   */
  private async waitForSocketOpen(socket: Socket): Promise<void> {
    const connectTimeoutMs = this.options.connectTimeoutMs ?? 10_000;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      await Promise.race([
        socket.opened,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`socket open timed out after ${connectTimeoutMs}ms`));
          }, connectTimeoutMs);
        }),
      ]);
    } catch (error) {
      await this.finalizeClose();
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private encodeForServer(text: string): Uint8Array {
    const enc = this.config.encoding?.toLowerCase();
    if (!enc || enc === "utf-8" || enc === "utf8") {
      return this.utf8Encoder.encode(text);
    }
    const encMap: Record<string, "JIS" | "EUCJP" | "SJIS"> = {
      "iso-2022-jp": "JIS",
      "euc-jp": "EUCJP",
      "shift_jis": "SJIS",
      "shift-jis": "SJIS",
    };
    const target = encMap[enc] ?? "JIS";
    const unicodeArray = Encoding.stringToCode(text);
    const encoded = Encoding.convert(unicodeArray, { to: target, from: "UNICODE" });
    return new Uint8Array(encoded);
  }

  private async readLoop(): Promise<void> {
    if (!this.socket) return;

    const decoder = new TextDecoder(this.config.encoding || "utf-8");
    const reader = this.socket.readable.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("IRC: read stream ended (done=true)");
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        console.log(`IRC: received ${chunk.length} bytes`);
        this.buffer += chunk;

        // Process complete lines
        let nlIdx: number;
        while ((nlIdx = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.substring(0, nlIdx);
          this.buffer = this.buffer.substring(nlIdx + 1);

          const trimmed = line.replace(/\r$/, "");
          if (trimmed.length === 0) continue;

          const msg = parse(trimmed);
          if (msg.command) {
            await this.onMessage(msg);
          }
        }
      }
    } catch (e) {
      // Connection error or closed
      console.error("IRC read error:", e);
    } finally {
      console.log("IRC: readLoop ended, closing connection");
      reader.releaseLock();
      await this.finalizeClose();
    }
  }

  async sendRaw(line: string): Promise<void> {
    if (/[\r\n\0]/.test(line)) {
      throw new Error("unsafe IRC line");
    }
    if (!this.writer) {
      throw new Error("socket writer unavailable");
    }
    try {
      await this.writer.write(this.encodeForServer(line + "\r\n"));
    } catch (error) {
      console.error("IRC write failed", error);
      await this.finalizeClose();
      throw error;
    }
  }

  async send(msg: IrcMessage): Promise<void> {
    await this.sendRaw(build(msg));
  }

  markConnected(): void {
    this._connected = true;
  }

  async close(): Promise<void> {
    await this.finalizeClose();
  }

  /**
   * Closes the underlying socket and invokes the close callback once.
   */
  private async finalizeClose(): Promise<void> {
    if (this.isClosed) {
      if (this.closePromise) {
        await this.closePromise;
      }
      return;
    }
    if (this.closePromise) {
      await this.closePromise;
      return;
    }

    const socket = this.socket;
    const writer = this.writer;

    this.socket = null;
    this.writer = null;
    this._connected = false;
    this.isClosed = true;
    this.buffer = "";

    this.closePromise = (async () => {
      try {
        if (writer) {
          try {
            writer.releaseLock();
          } catch {
            // Ignore release errors during shutdown.
          }
        }

        if (socket) {
          try {
            await socket.close();
          } catch {
            // Ignore close errors during shutdown.
          }
        }
      } finally {
        await this.onClose();
      }
    })();

    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
    }
  }
}
