import type { Db } from "../../db/index.ts";
import { schema } from "../../db/index.ts";
import type { Logger } from "../../log/index.ts";
import type * as td from "../../tdlib-api/td-api.ts";

type Row = typeof schema.rawUpdates.$inferInsert;

export interface RawUpdateWriterOptions {
  log: Logger;
  // Called once when buffered rows still fail to write after maxAttempts.
  // The rows stay buffered; the caller should exit
  onFatal(error: Error): void;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  // Rows held in memory while writes keep failing; push throws beyond this
  maxBuffered?: number;
}

export interface RawUpdateWriter {
  // Throws after close or when the buffer is full
  push(account: string, update: td.Update, receivedAt: number): void;
  // Last write at shutdown, without retries; throws if rows remain unstored
  close(): void;
  readonly buffered: number;
}

// Rows per INSERT, well under SQLite's bound-parameter limit
const CHUNK = 500;

// Buffers raw TDLib updates and writes each burst (one worker batch) in a single transaction.
// Rows leave the buffer only once committed, so a failed write keeps them in arrival order and the
// whole buffer is retried with backoff: a disk-full or locked database must not lose good data
export function createRawUpdateWriter(db: Db, options: RawUpdateWriterOptions): RawUpdateWriter {
  const { log } = options;
  const maxAttempts = options.maxAttempts ?? 8;
  const retryBaseMs = options.retryBaseMs ?? 200;
  const retryMaxMs = options.retryMaxMs ?? 10_000;
  const maxBuffered = options.maxBuffered ?? 100_000;

  let buffer: Row[] = [];
  let scheduled = false;
  let retryTimer: Timer | undefined;
  let failures = 0;
  let failed = false;
  let closed = false;

  function schedule(): void {
    // While a retry is pending, new rows wait behind the failed ones; after onFatal, nothing is retried
    if (scheduled || retryTimer !== undefined || failed) return;
    scheduled = true;
    queueMicrotask(write);
  }

  function flush(): void {
    if (buffer.length === 0) return;
    const rows = buffer;
    db.orm.transaction((tx) => {
      for (let i = 0; i < rows.length; i += CHUNK) {
        tx.insert(schema.rawUpdates)
          .values(rows.slice(i, i + CHUNK))
          .run();
      }
    });
    buffer = [];
  }

  function write(): void {
    scheduled = false;
    if (closed) return;
    try {
      flush();
    } catch (error) {
      onWriteFailed(error);
      return;
    }
    if (failures > 0) log.info("Raw update writes recovered after {failures} failures", { failures });
    failures = 0;
  }

  function onWriteFailed(error: unknown): void {
    failures++;
    if (failures >= maxAttempts) {
      failed = true;
      log.fatal("Raw update storage cannot recover", { buffered: buffer.length, error });
      options.onFatal(
        new Error(`Raw updates could not be written ${failures} times in a row`, { cause: error }),
      );
      return;
    }
    const delayMs = Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1));
    log.error("Failed to write {count} raw updates, retrying in {delayMs} ms", {
      count: buffer.length,
      delayMs,
      error,
    });
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      write();
    }, delayMs);
  }

  return {
    push(account, update, receivedAt) {
      if (closed) throw new Error(`Raw update ${update["@type"]} pushed after close`);
      if (buffer.length >= maxBuffered) throw new Error(`Raw update buffer full (${maxBuffered} rows)`);
      buffer.push({ account, type: update["@type"], payload: update, receivedAt });
      schedule();
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      try {
        flush();
      } catch (error) {
        throw new Error(`${buffer.length} raw updates were not stored at shutdown`, { cause: error });
      }
    },
    get buffered() {
      return buffer.length;
    },
  };
}
