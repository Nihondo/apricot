import { vi } from "vitest";

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function createMockSocket() {
  const opened = createDeferred<SocketInfo>();
  const closed = createDeferred<void>();
  const writes: string[] = [];
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  let writeError: Error | null = null;

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readableController = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (writeError) {
        throw writeError;
      }
      writes.push(textDecoder.decode(chunk));
    },
  });
  const close = vi.fn(async () => {
    try {
      readableController.close();
    } catch {
      // Ignore duplicate close calls in tests.
    }
    closed.resolve();
  });

  return {
    socket: {
      readable,
      writable,
      opened: opened.promise,
      closed: closed.promise,
      upgraded: false,
      secureTransport: "off",
      close,
      startTls: () => {
        throw new Error("not implemented in tests");
      },
    } as unknown as Socket,
    writes,
    opened,
    closed,
    close,
    pushMessage(line: string): void {
      readableController.enqueue(textEncoder.encode(`${line}\r\n`));
    },
    failWrites(error: Error): void {
      writeError = error;
    },
  };
}
