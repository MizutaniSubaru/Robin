import type { Db } from "../../db/index.ts";
import { schema } from "../../db/index.ts";
import type { Logger } from "../../log/index.ts";

type Update = { "@type": string } & Record<string, unknown>;
type Row = typeof schema.rawUpdates.$inferInsert;

export interface RawUpdateWriterOptions {
  log: Logger;
  // Called once when rows cannot be stored for good (write retries exhausted, buffer full).
  // Buffered rows are kept; the caller should exit
  onFatal(error: Error): void;
  // Consecutive failed writes before onFatal
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  // Rows held in memory while writes keep failing
  maxBuffered?: number;
}

export interface RawUpdateWriter {
  // Validates and buffers one update; invalid input is logged and dropped. Returns whether it was kept
  push(account: string, update: Update, receivedAt: number): boolean;
  // Last write at shutdown; no retries are scheduled after it and later pushes are dropped
  close(): void;
  readonly buffered: number;
}

// Rows per INSERT, well under SQLite's bound-parameter limit
const CHUNK = 500;
const TYPE_PATTERN = /^[a-zA-Z]\w*$/;

// Buffers raw TDLib updates and writes each burst (one worker batch) in a single transaction.
// Callers pass only the updates worth keeping (see createUpdateFilter).
//
// Failures: rows leave the buffer only once committed, so a failed write keeps them at the head
// in arrival order. Errors caused by a row (constraint, unserializable payload) are isolated by
// writing row by row and dropping just the bad ones. Errors from the environment (disk full, I/O,
// locked) hit every row alike, so the whole buffer is retried with backoff and onFatal fires
// after maxAttempts: dropping rows there would lose good data
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
  let overflowed = 0;
  let failed = false;
  let closed = false;

  function schedule(): void {
    // While a retry is pending, new rows wait behind the failed ones
    if (scheduled || retryTimer !== undefined) return;
    scheduled = true;
    queueMicrotask(write);
  }

  function write(): void {
    scheduled = false;
    if (buffer.length === 0) return;
    try {
      insertAll(buffer);
    } catch (error) {
      if (!isRowError(error)) {
        onWriteFailed(error);
        return;
      }
      try {
        insertEach(buffer);
      } catch (envError) {
        onWriteFailed(envError);
        return;
      }
    }
    buffer = [];
    if (failures > 0) log.info("Raw update writes recovered after {failures} failures", { failures });
    failures = 0;
  }

  function insertAll(rows: Row[]): void {
    db.orm.transaction((tx) => {
      for (let i = 0; i < rows.length; i += CHUNK) {
        tx.insert(schema.rawUpdates)
          .values(rows.slice(i, i + CHUNK))
          .run();
      }
    });
  }

  // One transaction, one statement per row: a failed statement leaves the others in place,
  // and an environment error rethrows so the whole transaction rolls back
  function insertEach(rows: Row[]): void {
    let dropped = 0;
    db.orm.transaction((tx) => {
      for (const row of rows) {
        try {
          tx.insert(schema.rawUpdates).values(row).run();
        } catch (error) {
          if (!isRowError(error)) throw error;
          dropped++;
          log.error("Dropped raw update {type} that cannot be stored", {
            type: row.type,
            account: row.account,
            receivedAt: row.receivedAt,
            error,
          });
        }
      }
    });
    if (dropped > 0)
      log.warn("Stored {stored} raw updates, dropped {dropped}", { stored: rows.length - dropped, dropped });
  }

  function onWriteFailed(error: unknown): void {
    failures++;
    if (closed) {
      log.error("Failed to write {count} raw updates at shutdown", { count: buffer.length, error });
      return;
    }
    if (failures >= maxAttempts) {
      fail(new Error(`Raw updates could not be written ${failures} times in a row: ${String(error)}`));
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

  function fail(error: Error): void {
    if (failed) return;
    failed = true;
    log.fatal("Raw update storage cannot recover: {message}", {
      message: error.message,
      buffered: buffer.length,
    });
    options.onFatal(error);
  }

  return {
    push(account, update, receivedAt) {
      if (closed) {
        log.warn("Dropped raw update {type} after close", { type: update?.["@type"], account });
        return false;
      }
      const problem = validate(account, update, receivedAt);
      if (problem) {
        log.warn("Dropped invalid raw update: {problem}", { problem, account, type: update?.["@type"] });
        return false;
      }
      if (buffer.length >= maxBuffered) {
        overflowed++;
        if (overflowed === 1 || overflowed % 1000 === 0) {
          log.error("Raw update buffer full, dropped {overflowed} updates", { overflowed });
        }
        fail(new Error(`Raw update buffer full (${maxBuffered} rows)`));
        return false;
      }
      const { "@client_id": _clientId, ...payload } = update;
      buffer.push({ account, type: update["@type"], payload, receivedAt });
      schedule();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      write();
      if (buffer.length > 0) log.error("{count} raw updates were not stored", { count: buffer.length });
    },
    get buffered() {
      return buffer.length;
    },
  };
}

function validate(account: unknown, update: unknown, receivedAt: unknown): string | undefined {
  if (typeof account !== "string" || account === "") return "account must be a non-empty string";
  if (typeof update !== "object" || update === null || Array.isArray(update))
    return "update must be an object";
  const type = (update as Record<string, unknown>)["@type"];
  if (typeof type !== "string" || !TYPE_PATTERN.test(type)) return "@type is missing or malformed";
  if (typeof receivedAt !== "number" || !Number.isSafeInteger(receivedAt) || receivedAt <= 0) {
    return "receivedAt must be a positive integer (µs)";
  }
  return undefined;
}

// Errors a single row can cause; anything else (SQLITE_FULL, SQLITE_IOERR, SQLITE_BUSY, ...) is
// treated as the environment and retried
function isRowError(error: unknown): boolean {
  // JSON.stringify on a BigInt or a cycle
  if (error instanceof TypeError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  return code.startsWith("SQLITE_CONSTRAINT") || code === "SQLITE_MISMATCH" || code === "SQLITE_TOOBIG";
}
