import { describe, expect, test } from "bun:test";

import type { RobinEvent } from "../../src/core/events/index.ts";
import { ChatState, initialState, reduce } from "../../src/core/reducer/index.ts";
import { CHAT, createEventFactory, text } from "../fixtures/events.ts";

const window = { maxItems: 4, blockSize: 2 };
const alice = "tg:user:1";

function scenario(): RobinEvent[] {
  const event = createEventFactory();
  return [
    event({ kind: "alias.assigned", user: alice, alias: "u1", name: "Alice" }, { account: "robin" }),
    event({
      kind: "message.created",
      messageId: "41",
      sender: alice,
      senderName: "Alice",
      replyTo: null,
      forwardedFrom: null,
      content: text("hi"),
    }),
    event({ kind: "self.message", runId: "r1", replyTo: "41", content: text("hello") }, { eventId: "s1" }),
    event({ kind: "message.edited", messageId: "41", editKey: "1", content: text("hi!") }),
    event(
      { kind: "self.send_result", target: "s1", result: "sent", messageId: "42", tempId: null, error: null },
      { account: "bot" },
    ),
    event({ kind: "user.renamed", user: alice, from: "Alice", to: "Ally" }, { account: "robin" }),
    event({
      kind: "message.created",
      messageId: "43",
      sender: alice,
      senderName: "Ally",
      replyTo: { type: "message", messageId: "42", quote: null },
      forwardedFrom: null,
      content: text("thanks"),
    }),
    event({ kind: "message.deleted", messageId: "43" }),
    event({
      kind: "message.created",
      messageId: "44",
      sender: alice,
      senderName: "Ally",
      replyTo: null,
      forwardedFrom: null,
      content: text("again"),
    }),
  ];
}

describe("reduce", () => {
  test("folds messages, edits, deletions, renames and send results", () => {
    const state = reduce(initialState(CHAT, { maxItems: 100, blockSize: 10 }), scenario());
    expect(state.users).toEqual({ [alice]: { alias: "u1", name: "Ally" } });
    expect(
      state.timeline.map((item) => (item.type === "renamed" ? item.type : [item.type, item.messageId])),
    ).toEqual([["message", "41"], ["self_message", "42"], "renamed", ["message", "43"], ["message", "44"]]);
    const [first, self, , deleted] = state.timeline;
    expect(first).toMatchObject({ edited: true, content: text("hi!") });
    expect(self).toMatchObject({ status: "sent", replyTo: "41" });
    expect(deleted).toMatchObject({ deleted: true });
    expect(state.lastTs).toBe(scenario().at(-1)?.ts ?? 0);
  });

  test("folding in batches gives the same state as folding at once", () => {
    const events = scenario();
    const whole = reduce(initialState(CHAT, window), events);
    for (let split = 0; split <= events.length; split++) {
      const parts = reduce(reduce(initialState(CHAT, window), events.slice(0, split)), events.slice(split));
      expect(parts).toEqual(whole);
    }
  });

  test("repeated events change nothing", () => {
    const events = scenario();
    const once = reduce(initialState(CHAT, { maxItems: 100, blockSize: 10 }), events);
    const twice = reduce(
      once,
      events.map((e) => ({ ...e, ts: e.ts + 100_000_000 })),
    );
    expect(twice.timeline).toEqual(once.timeline);
    expect(twice.users).toEqual(once.users);
  });

  test("drops the oldest block once the window is full", () => {
    const state = reduce(initialState(CHAT, window), scenario());
    // 5 items with maxItems 4: the first block of 2 went
    expect(state.omitted).toBe(2);
    expect(state.timeline).toHaveLength(3);
    expect(state.timeline[0]?.type).toBe("renamed");
  });

  test("keeps the input state untouched", () => {
    const start = reduce(initialState(CHAT, window), scenario().slice(0, 3));
    const copy = structuredClone(start);
    reduce(start, scenario().slice(3));
    expect(start).toEqual(copy);
  });

  test("a restart marks a pending send unknown, and a late confirmation still lands", () => {
    const event = createEventFactory();
    const state = reduce(initialState(CHAT, window), [
      event({ kind: "self.message", runId: "r1", replyTo: null, content: text("x") }, { eventId: "s1" }),
      event({
        kind: "self.send_result",
        target: "s1",
        result: "unknown",
        messageId: null,
        tempId: null,
        error: null,
      }),
      event({
        kind: "self.send_result",
        target: "s1",
        result: "sent",
        messageId: "9",
        tempId: null,
        error: null,
      }),
      // A final state stays final
      event({
        kind: "self.send_result",
        target: "s1",
        result: "failed",
        messageId: null,
        tempId: null,
        error: "x",
      }),
    ]);
    expect(state.timeline[0]).toMatchObject({ status: "sent", messageId: "9" });
  });

  test("rejects events of another chat", () => {
    const event = createEventFactory("tg:-1");
    expect(() =>
      reduce(initialState(CHAT, window), [event({ kind: "message.deleted", messageId: "1" })]),
    ).toThrow(/folded into/);
  });

  test("the state survives a JSON round trip through its schema", () => {
    const state = reduce(initialState(CHAT, window), scenario());
    expect(ChatState.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});
