import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RobinEvent } from "../../src/core/events/index.ts";
import {
  createEventStore,
  createInbound,
  createProjection,
  createTsClock,
  type EventStore,
  type InboundEvent,
} from "../../src/core/store/index.ts";
import { type Db, openDb, runMigrations, schema } from "../../src/db/index.ts";
import { getLogger } from "../../src/log/index.ts";
import { text } from "../fixtures/events.ts";

const log = getLogger("test");
const CHAT = "tg:-100123";
const alice = "tg:user:1";
const bob = "tg:user:2";
const T0 = 1_800_000_000_000_000;

let db: Db;
let store: EventStore;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  store = createEventStore(db, log);
});

afterEach(() => db.close());

function message(
  messageId: string,
  sender: string,
  name: string,
  receivedAt: number,
  extra = {},
): InboundEvent {
  return {
    type: "event",
    chat: CHAT,
    account: "user",
    receivedAt,
    serverDate: Math.floor(receivedAt / 1_000_000),
    body: {
      kind: "message.created",
      messageId,
      sender,
      senderName: name,
      replyTo: null,
      forwardedFrom: null,
      content: text(`from ${name}`),
    },
    users: { [sender]: name },
    ...extra,
  };
}

const kinds = (events: readonly RobinEvent[]) => events.map((e) => e.kind);

describe("createTsClock", () => {
  test("follows the hint but never goes back or repeats", () => {
    const raised: number[] = [];
    const clock = createTsClock(100, (by) => raised.push(by));
    expect([clock.next(50), clock.next(200), clock.next(200), clock.next(5_000_000)]).toEqual([
      101, 200, 201, 5_000_000,
    ]);
    expect(clock.next(1)).toBe(5_000_001);
    expect(raised).toEqual([5_000_000]);
  });
});

describe("createEventStore", () => {
  test("assigns aliases on first sight and records renames, ahead of the message", () => {
    expect(kinds(store.commitInbound(message("1", alice, "Alice", T0)))).toEqual([
      "alias.assigned",
      "message.created",
    ]);
    expect(kinds(store.commitInbound(message("2", bob, "Bob", T0 + 1)))).toEqual([
      "alias.assigned",
      "message.created",
    ]);
    expect(kinds(store.commitInbound(message("3", alice, "Ally", T0 + 2)))).toEqual([
      "user.renamed",
      "message.created",
    ]);
    const events = store.read(CHAT, 0);
    expect(events.flatMap((e) => (e.kind === "alias.assigned" ? [[e.user, e.alias, e.name]] : []))).toEqual([
      [alice, "u1", "Alice"],
      [bob, "u2", "Bob"],
    ]);
    expect(events.find((e) => e.kind === "user.renamed")).toMatchObject({ from: "Alice", to: "Ally" });
    // Strictly increasing ts in log order
    const ts = events.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(new Set(ts).size).toBe(ts.length);
  });

  test("numbers several new users in one event without collisions", () => {
    const item = message("1", alice, "Alice", T0, { users: { [alice]: "Alice", [bob]: "Bob" } });
    item.body = {
      ...item.body,
      kind: "message.created",
      content: [
        {
          type: "text",
          text: "hi Bob",
          entities: [{ type: "mention_user", user: bob, offset: 3, length: 3 }],
        },
      ],
    } as InboundEvent["body"];
    store.commitInbound(item);
    expect(store.read(CHAT, 0).flatMap((e) => (e.kind === "alias.assigned" ? [e.alias] : []))).toEqual([
      "u1",
      "u2",
    ]);
  });

  test("a duplicate is not written and derives nothing", () => {
    store.commitInbound(message("1", alice, "Alice", T0));
    expect(store.commitInbound(message("1", alice, "Alias", T0 + 5))).toEqual([]);
    expect(kinds(store.read(CHAT, 0))).toEqual(["alias.assigned", "message.created"]);
  });

  // Regression: edits within one second shared a dedup key and all but the first were dropped
  test("edits are deduplicated by their edit key, not their edit date", () => {
    store.commitInbound(message("41", alice, "Alice", T0));
    const edit = (editKey: string, value: string): InboundEvent => ({
      type: "event",
      chat: CHAT,
      account: "user",
      receivedAt: T0 + Number(editKey),
      serverDate: Math.floor(T0 / 1_000_000) + 1,
      body: { kind: "message.edited", messageId: "41", editKey, content: text(value) },
      users: {},
    });
    expect(kinds(store.commitInbound(edit("1", "He")))).toEqual(["message.edited"]);
    expect(kinds(store.commitInbound(edit("2", "Hello")))).toEqual(["message.edited"]);
    expect(store.commitInbound(edit("2", "Hello"))).toEqual([]);
    const window = { maxItems: 300, blockSize: 50 };
    expect(createProjection(db, store, log, { window }).load(CHAT).timeline[0]).toMatchObject({
      content: text("Hello"),
    });
  });

  test("aliases survive a restart", () => {
    store.commitInbound(message("1", alice, "Alice", T0));
    const reopened = createEventStore(db, log);
    expect(kinds(reopened.commitInbound(message("2", bob, "Bob", T0 + 1)))).toEqual([
      "alias.assigned",
      "message.created",
    ]);
    expect(
      reopened
        .read(CHAT, 0)
        .filter((e) => e.kind === "alias.assigned")
        .map((e) => e.ts),
    ).toHaveLength(2);
    const aliases = reopened.read(CHAT, 0).flatMap((e) => (e.kind === "alias.assigned" ? [e.alias] : []));
    expect(aliases).toEqual(["u1", "u2"]);
    // ts continues after the last stored one even if the hint is older
    expect(
      createEventStore(db, log).appendSelf(CHAT, "bot", {
        kind: "self.message",
        runId: "r",
        replyTo: null,
        content: text("x"),
      })?.ts,
    ).toBeGreaterThan(T0 + 1);
  });

  test("tracks pending sends until a final result", () => {
    const sent = store.appendSelf(CHAT, "bot", {
      kind: "self.message",
      runId: "r",
      replyTo: null,
      content: text("a"),
    });
    const pending = store.appendSelf(CHAT, "bot", {
      kind: "self.message",
      runId: "r",
      replyTo: null,
      content: text("b"),
    });
    if (!sent || !pending) throw new Error("not written");
    const result = (target: string, r: "accepted" | "sent", extra = {}) => ({
      kind: "self.send_result" as const,
      target,
      result: r,
      messageId: null,
      tempId: null,
      error: null,
      ...extra,
    });
    store.appendSelf(CHAT, "bot", result(sent.eventId, "accepted", { tempId: "7" }));
    store.appendSelf(CHAT, "bot", result(sent.eventId, "sent", { messageId: "55" }));
    store.appendSelf(CHAT, "bot", result(pending.eventId, "accepted", { tempId: "8" }));
    // Deduplicated by target and result
    expect(
      store.appendSelf(CHAT, "bot", result(pending.eventId, "accepted", { tempId: "8" })),
    ).toBeUndefined();
    expect(store.pendingSends()).toEqual([{ chat: CHAT, eventId: pending.eventId, tempId: "8" }]);
    expect(store.isSelfMessage(CHAT, "55")).toBe(true);
    expect(store.isSelfMessage(CHAT, "56")).toBe(false);
  });

  test("profile updates rename the user in every chat that knows them", () => {
    store.commitInbound(message("1", alice, "Alice", T0));
    expect(store.chatsKnowing(alice)).toEqual([CHAT]);
    expect(
      kinds(store.commitProfile({ type: "profile", user: alice, name: "Ally", receivedAt: T0 + 1 }, CHAT)),
    ).toEqual(["user.renamed"]);
    expect(
      store.commitProfile({ type: "profile", user: alice, name: "Ally", receivedAt: T0 + 2 }, CHAT),
    ).toEqual([]);
  });
});

describe("createInbound", () => {
  test("commits each chat in arrival order even when transforms finish out of order", async () => {
    const delays: Record<string, number> = { "1": 30, "2": 0, "3": 10 };
    const inbound = createInbound(store, log, {
      transform: async (item) => {
        if (item.body.kind === "message.created") await Bun.sleep(delays[item.body.messageId] ?? 0);
        return item;
      },
      onFatal: (error) => {
        throw error;
      },
    });
    inbound.accept(message("1", alice, "Alice", T0));
    inbound.accept(message("2", alice, "Alice", T0 + 1));
    inbound.accept(message("3", alice, "Alice", T0 + 2));
    await inbound.idle();
    expect(store.read(CHAT, 0).flatMap((e) => (e.kind === "message.created" ? [e.messageId] : []))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  test("gives up on a transform that keeps failing and commits the event as received", async () => {
    const inbound = createInbound(store, log, {
      transform: () => Promise.reject(new Error("vision model down")),
      giveUpAfterMs: 30,
      retryBaseMs: 5,
      onFatal: (error) => {
        throw error;
      },
    });
    inbound.accept(message("1", alice, "Alice", T0));
    await inbound.idle();
    expect(kinds(store.read(CHAT, 0))).toEqual(["alias.assigned", "message.created"]);
  });

  test("records chat metadata directly", () => {
    const inbound = createInbound(store, log, { onFatal: () => {} });
    inbound.accept({
      type: "chat",
      chat: CHAT,
      chatType: "supergroup",
      title: "Lab",
      inboundAccount: "user",
    });
    inbound.accept({
      type: "chat",
      chat: CHAT,
      chatType: "supergroup",
      title: "Lab 2",
      inboundAccount: "user",
    });
    expect(db.orm.select().from(schema.chats).all()).toEqual([
      { chat: CHAT, type: "supergroup", title: "Lab 2", inboundAccount: "user" },
    ]);
  });
});

describe("createProjection", () => {
  const window = { maxItems: 50, blockSize: 10 };

  test("folds from the snapshot and gives the same state as a full fold", () => {
    const projection = createProjection(db, store, log, { window, snapshotEvery: 1_000 });
    store.commitInbound(message("1", alice, "Alice", T0));
    projection.save(projection.load(CHAT));
    store.commitInbound(message("2", bob, "Bob", T0 + 1));
    const incremental = projection.load(CHAT);

    db.orm.delete(schema.chatSnapshots).run();
    expect(projection.load(CHAT)).toEqual(incremental);
    expect(incremental.timeline).toHaveLength(2);
  });

  test("discards a snapshot from another window size", () => {
    store.commitInbound(message("1", alice, "Alice", T0));
    createProjection(db, store, log, { window }).save(
      createProjection(db, store, log, { window }).load(CHAT),
    );
    const other = createProjection(db, store, log, { window: { maxItems: 5, blockSize: 1 } }).load(CHAT);
    expect(other.window).toEqual({ maxItems: 5, blockSize: 1 });
    expect(other.timeline).toHaveLength(1);
  });
});
