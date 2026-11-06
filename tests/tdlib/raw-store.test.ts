import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { asc } from "drizzle-orm";

import { type Db, openDb, runMigrations, schema } from "../../src/db/index.ts";
import { getLogger } from "../../src/log/index.ts";
import {
  createRawUpdateWriter,
  type RawUpdateWriter,
  type RawUpdateWriterOptions,
} from "../../src/sources/tdlib/raw-store.ts";
import { update } from "../fixtures/td.ts";

let db: Db;
let fatal: Error[];
let writers: RawUpdateWriter[];

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  fatal = [];
  writers = [];
});

afterEach(() => {
  for (const w of writers) w.close();
  db.close();
});

const rows = () => db.orm.select().from(schema.rawUpdates).orderBy(asc(schema.rawUpdates.id)).all();

function writer(overrides: Partial<RawUpdateWriterOptions> = {}): RawUpdateWriter {
  const w = createRawUpdateWriter(db, {
    log: getLogger("test"),
    onFatal: (error) => fatal.push(error),
    retryBaseMs: 5,
    retryMaxMs: 20,
    ...overrides,
  });
  writers.push(w);
  return w;
}

// Caps the database at its current size, so every further insert fails with SQLITE_FULL
function fillDisk(): () => void {
  const { page_count } = db.client.query("PRAGMA page_count").get() as { page_count: number };
  db.client.run(`PRAGMA max_page_count = ${page_count}`);
  return () => db.client.run("PRAGMA max_page_count = 1073741823");
}

const big = (i: number) => update({ "@type": "updateNewMessage", n: i, blob: "x".repeat(20_000) });

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("createRawUpdateWriter", () => {
  test("writes a burst of pushes in arrival order after the current task", async () => {
    const w = writer();
    for (let i = 0; i < 1200; i++) {
      w.push(i % 2 ? "bot" : "user", update({ "@type": "updateOption", name: `n${i}` }), 1000 + i);
    }
    expect(rows()).toHaveLength(0);

    await Promise.resolve();
    const stored = rows();
    expect(stored).toHaveLength(1200);
    expect(stored[0]).toMatchObject({
      account: "user",
      type: "updateOption",
      payload: { "@type": "updateOption", name: "n0" },
      receivedAt: 1000,
    });
    expect(stored.map((r) => r.receivedAt)).toEqual(Array.from({ length: 1200 }, (_, i) => 1000 + i));
  });

  test("close writes what is buffered and rejects later pushes", () => {
    const w = writer();
    w.push("user", update({ "@type": "updateConnectionState" }), 1);
    w.close();
    expect(rows()).toHaveLength(1);
    expect(() => w.push("user", update({ "@type": "updateConnectionState" }), 2)).toThrow(/after close/);
  });

  test("close on a full disk throws and does not schedule retries", async () => {
    const w = writer({ maxAttempts: 2 });
    fillDisk();
    w.push("user", big(1), 1);
    expect(() => w.close()).toThrow(/1 raw updates were not stored/);
    await Bun.sleep(50);
    expect(w.buffered).toBe(1);
    expect(fatal).toHaveLength(0);
  });

  test("keeps rows in order through a full disk and writes them once space is back", async () => {
    const w = writer({ maxAttempts: 100 });
    const freeDisk = fillDisk();
    for (let i = 1; i <= 5; i++) w.push("user", big(i), i);
    await Bun.sleep(30);
    expect(rows()).toHaveLength(0);
    expect(w.buffered).toBe(5);

    // Pushes during the outage queue behind the failed rows
    for (let i = 6; i <= 8; i++) w.push("user", big(i), i);
    freeDisk();
    await until(() => w.buffered === 0);
    expect(rows().map((r) => r.receivedAt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fatal).toHaveLength(0);
  });

  test("reports fatal after the retry limit and keeps the rows", async () => {
    const w = writer({ maxAttempts: 3 });
    const freeDisk = fillDisk();
    w.push("user", big(1), 1);
    await until(() => fatal.length > 0);
    await Bun.sleep(50);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]?.message).toMatch(/3 times in a row/);
    expect(w.buffered).toBe(1);
    // Later pushes stay buffered and do not report again
    w.push("user", big(2), 2);
    await Bun.sleep(50);
    expect(fatal).toHaveLength(1);
    expect(w.buffered).toBe(2);
    freeDisk();
  });

  test("push throws when the buffer is full", () => {
    const w = writer({ maxBuffered: 2 });
    w.push("user", update({ "@type": "updateNewMessage" }), 1);
    w.push("user", update({ "@type": "updateNewMessage" }), 2);
    expect(() => w.push("user", update({ "@type": "updateNewMessage" }), 3)).toThrow(/buffer full/);
    expect(w.buffered).toBe(2);
  });
});
