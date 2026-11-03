import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { type Db, openDb, runMigrations, schema } from "../src/db/index.ts";

let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
});

afterEach(() => db.close());

const baseEvent = {
  tsSource: "local" as const,
  serverDate: null,
  chat: "tg:-100123",
  kind: "message.created",
  account: "user",
  payload: { messageId: "41", content: [] },
};

describe("migrations", () => {
  test("creates all tables", () => {
    const tables = db.client
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual([
      "agent_runs",
      "chat_snapshots",
      "chats",
      "events",
      "files",
      "llm_calls",
      "media_descriptions",
      "raw_updates",
      "stickers",
      "tool_calls",
      "users",
    ]);
  });

  test("is idempotent", () => {
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe("events", () => {
  test("round-trips payload as JSON and defaults v to 1", () => {
    db.orm
      .insert(schema.events)
      .values({ ...baseEvent, eventId: "e1", ts: 1, dedupKey: "m:41" })
      .run();
    const row = db.orm.select().from(schema.events).where(eq(schema.events.eventId, "e1")).get();
    expect(row?.payload).toEqual(baseEvent.payload);
    expect(row?.v).toBe(1);
  });

  test("dedupes on (chat, dedup_key)", () => {
    const insert = (eventId: string, ts: number) =>
      db.orm
        .insert(schema.events)
        .values({ ...baseEvent, eventId, ts, dedupKey: "m:41" })
        .onConflictDoNothing()
        .run();
    insert("e1", 1);
    insert("e2", 2);
    const rows = db.orm.select().from(schema.events).all();
    expect(rows.map((r) => r.eventId)).toEqual(["e1"]);
  });

  test("does not dedupe NULL dedup_key", () => {
    db.orm
      .insert(schema.events)
      .values({ ...baseEvent, eventId: "e1", ts: 1, dedupKey: null })
      .run();
    db.orm
      .insert(schema.events)
      .values({ ...baseEvent, eventId: "e2", ts: 2, dedupKey: null })
      .run();
    expect(db.orm.select().from(schema.events).all()).toHaveLength(2);
  });

  test("enforces unique event_id", () => {
    db.orm
      .insert(schema.events)
      .values({ ...baseEvent, eventId: "e1", ts: 1, dedupKey: "a" })
      .run();
    expect(() =>
      db.orm
        .insert(schema.events)
        .values({ ...baseEvent, eventId: "e1", ts: 2, dedupKey: "b" })
        .run(),
    ).toThrow();
  });

  test("keeps microsecond ts precision", () => {
    const ts = 1_793_600_000_123_456; // a µs timestamp around 2026
    db.orm
      .insert(schema.events)
      .values({ ...baseEvent, eventId: "e1", ts, dedupKey: null })
      .run();
    const [row] = db.orm.select().from(schema.events).orderBy(asc(schema.events.ts)).all();
    expect(row?.ts).toBe(ts);
  });
});

describe("agent runs", () => {
  test("enforces llm_calls foreign key", () => {
    expect(() =>
      db.orm
        .insert(schema.llmCalls)
        .values({ runId: "missing", provider: "anthropic", model: "m", request: {} })
        .run(),
    ).toThrow();

    db.orm.insert(schema.agentRuns).values({ runId: "r1", chat: "tg:-100123", trigger: "manual" }).run();
    db.orm
      .insert(schema.llmCalls)
      .values({ runId: "r1", provider: "anthropic", model: "m", request: {} })
      .run();
    const run = db.orm.select().from(schema.agentRuns).get();
    expect(run?.status).toBe("running");
    expect(run?.startedAt).toBeGreaterThan(0);
  });
});
