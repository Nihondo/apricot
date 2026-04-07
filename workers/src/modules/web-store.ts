/**
 * Web ログの保存、採番、永続化を扱う。
 */

import type {
  ChannelLogsChangedCallback,
  PersistedStoredMessage,
  PersistedWebLogs,
  PersistLogsCallback,
  StoredMessage,
} from "./web-types";

interface WebStoreOptions {
  maxLines: number;
  persistLogs?: PersistLogsCallback;
  onChannelLogsChanged?: ChannelLogsChangedCallback;
}

/**
 * チャンネル単位のメッセージストアを生成する。
 */
export function createWebStore(options: WebStoreOptions) {
  const store = new Map<string, StoredMessage[]>();
  const channelSequences = new Map<string, number>();

  function getBuffer(channel: string): StoredMessage[] {
    const key = channel.toLowerCase();
    let buffer = store.get(key);
    if (!buffer) {
      buffer = [];
      store.set(key, buffer);
    }
    return buffer;
  }

  function getNextChannelSequence(channel: string): number {
    const normalizedChannel = channel.toLowerCase();
    const nextSequence = (channelSequences.get(normalizedChannel) ?? 0) + 1;
    channelSequences.set(normalizedChannel, nextSequence);
    return nextSequence;
  }

  function normalizeStoredMessage(
    message: PersistedStoredMessage,
    fallbackSequence: number,
  ): StoredMessage {
    const rawSequence = typeof message.sequence === "number" && Number.isFinite(message.sequence)
      ? Math.trunc(message.sequence)
      : 0;
    return {
      ...message,
      sequence: rawSequence > 0 ? rawSequence : fallbackSequence,
    };
  }

  async function persistSnapshot(): Promise<void> {
    if (!options.persistLogs) {
      return;
    }
    await options.persistLogs(snapshotLogs());
  }

  function pushMessage(channel: string, message: Omit<StoredMessage, "sequence">): StoredMessage {
    const buffer = getBuffer(channel);
    const storedMessage: StoredMessage = {
      ...message,
      sequence: getNextChannelSequence(channel),
    };
    buffer.push(storedMessage);
    if (buffer.length > options.maxLines) {
      buffer.splice(0, buffer.length - options.maxLines);
    }
    return storedMessage;
  }

  async function appendMessage(
    channel: string,
    message: Omit<StoredMessage, "sequence">,
  ): Promise<void> {
    pushMessage(channel, message);
    await persistSnapshot();
    options.onChannelLogsChanged?.([channel]);
  }

  async function appendMessages(
    entries: Array<[string, Omit<StoredMessage, "sequence">]>,
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    for (const [channel, message] of entries) {
      pushMessage(channel, message);
    }
    await persistSnapshot();
    options.onChannelLogsChanged?.(Array.from(new Set(entries.map(([channel]) => channel))));
  }

  function snapshotLogs(): PersistedWebLogs {
    return Object.fromEntries(
      Array.from(store.entries()).map(([channel, messages]) => [
        channel,
        messages.map((message) => ({ ...message })),
      ]),
    );
  }

  function hydrateLogs(snapshot?: PersistedWebLogs | null): void {
    store.clear();
    channelSequences.clear();
    if (!snapshot) {
      return;
    }

    for (const [channel, messages] of Object.entries(snapshot)) {
      let latestSequence = 0;
      const restored = messages.slice(-options.maxLines).map((message) => {
        const normalizedMessage = normalizeStoredMessage(message, latestSequence + 1);
        latestSequence = Math.max(latestSequence, normalizedMessage.sequence);
        return normalizedMessage;
      });
      const normalizedChannel = channel.toLowerCase();
      store.set(normalizedChannel, restored);
      channelSequences.set(normalizedChannel, latestSequence);
    }
  }

  function getChannelTopic(channel: string): string {
    const buffer = getBuffer(channel);
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (buffer[index].type === "topic") {
        return buffer[index].text;
      }
    }
    return "";
  }

  function getChannelLogs(channel: string): StoredMessage[] | null {
    const buffer = store.get(channel.toLowerCase());
    return buffer ? [...buffer] : null;
  }

  function getChannelMessages(channel: string): StoredMessage[] {
    return [...getBuffer(channel)];
  }

  function getChannelLatestSequence(channel: string): number {
    const buffer = store.get(channel.toLowerCase());
    return buffer && buffer.length > 0 ? buffer[buffer.length - 1].sequence : 0;
  }

  return {
    appendMessage,
    appendMessages,
    getChannelLatestSequence,
    getChannelLogs,
    getChannelMessages,
    getChannelTopic,
    hydrateLogs,
    snapshotLogs,
  };
}
