import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createScheduler,
  createSelfSender,
  createTrace,
  type Outbound,
  type RunDeps,
  runChat,
  type SendOutcome,
  type Trigger,
} from "../../src/agent/index.ts";
import {
  createEventStore,
  createProjection,
  type EventStore,
  type InboundEvent,
  type Projection,
} from "../../src/core/store/index.ts";
import { type Db, openDb, runMigrations, schema } from "../../src/db/index.ts";
import type { AssistantPart, LlmProvider, LlmRequest } from "../../src/llm/index.ts";
import { LlmError } from "../../src/llm/index.ts";
import { getLogger } from "../../src/log/index.ts";
import { text } from "../fixtures/events.ts";

const log = getLogger("test");
const GROUP = "tg:-100123";
const DM = "tg:bot:7";
const alice = "tg:user:7";
const T0 = 1_800_000_000_000_000;

let db: Db;
let store: EventStore;
let projection: Projection;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  store = createEventStore(db, log);
  projection = createProjection(db, store, log, { window: { maxItems: 100, blockSize: 10 } });
  store.upsertChat({
    type: "chat",
    chat: GROUP,
    chatType: "supergroup",
    title: "Lab",
    inboundAccount: "user",
  });
  store.upsertChat({ type: "chat", chat: DM, chatType: "private", title: "Alice", inboundAccount: "bot" });
});

afterEach(() => db.close());

function inbound(
  chat: string,
  messageId: string,
  body: Partial<InboundEvent["body"]> = {},
  at = T0,
): InboundEvent {
  return {
    type: "event",
    chat,
    account: "user",
    receivedAt: at,
    serverDate: Math.floor(at / 1e6),
    users: { [alice]: "Alice" },
    body: {
      kind: "message.created",
      messageId,
      sender: alice,
      senderName: "Alice",
      replyTo: null,
      forwardedFrom: null,
      content: text("hi robin"),
      ...body,
    } as InboundEvent["body"],
  };
}

// Answers each request with the next scripted turn and records what it was asked
function scriptedProvider(turns: AssistantPart[][]) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    name: "scripted",
    kind: "messages",
    model: "test-model",
    complete(request) {
      requests.push(structuredClone(request));
      const parts = turns.shift();
      if (!parts) throw new Error("Script ran out");
      return Promise.resolve({
        wireRequest: {},
        wireResponse: {},
        response: {
          parts,
          stopReason: parts.some((p) => p.type === "tool_call") ? "tool_use" : "end",
          model: "test-model",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      });
    },
  };
  return { provider, requests };
}

function fakeOutbound(outcomes: SendOutcome[] = []) {
  const sent: { chat: string; text: string; replyTo: string | null }[] = [];
  let next = 100;
  const outbound: Outbound = {
    maxTextLength: 50,
    send(chat, formatted, replyTo, onAccepted) {
      sent.push({ chat, text: formatted.text, replyTo });
      onAccepted(String(next));
      return Promise.resolve(
        outcomes.shift() ?? { ok: true, messageId: String(next++), date: 1_800_000_100 },
      );
    },
    reconcile: () => new Promise<SendOutcome>(() => {}),
  };
  return { outbound, sent };
}

const call = (name: string, args: unknown, id = `call_${name}`): AssistantPart => ({
  type: "tool_call",
  id,
  name,
  arguments: JSON.stringify(args),
});

function deps(provider: LlmProvider, outbound: Outbound): RunDeps {
  return {
    store,
    projection,
    provider,
    sender: createSelfSender(store, outbound, "bot", log),
    trace: createTrace(db),
    log,
    options: { persona: "You are Robin.", timezone: "UTC", maxSteps: 4, maxSends: 2, maxTextLength: 50 },
  };
}

const trigger: Trigger = { reason: "mention", messageId: "41" };

describe("runChat", () => {
  test("renders the chat, sends through Pipeline B, ends the turn, and traces everything", async () => {
    store.commitInbound(inbound(GROUP, "41"));
    const { provider, requests } = scriptedProvider([
      [
        { type: "text", text: "thinking aloud" },
        call("send_message", { text: "**Hello** Alice", reply_to: "m41" }),
      ],
      [call("end_turn", {})],
    ]);
    const { outbound, sent } = fakeOutbound();
    await runChat(deps(provider, outbound), GROUP, trigger, new AbortController().signal);

    // Plain text from the model is never sent; Markdown becomes entities
    expect(sent).toEqual([{ chat: GROUP, text: "Hello Alice", replyTo: "41" }]);
    const first = requests[0];
    expect(first?.system).toContain("You are in a Telegram group");
    expect(first?.tools.map((t) => t.name)).toEqual(["send_message", "end_turn"]);
    expect(first?.messages[0]).toEqual({
      role: "user",
      parts: [
        { type: "text", text: expect.stringContaining('<message id="m41" from="u1" name="Alice"') },
        { type: "text", text: expect.stringContaining('<trigger reason="mention" message="m41"/>') },
      ],
    });
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      results: [{ callId: "call_send_message", content: '{"sent":true,"id":"m100"}', isError: false }],
    });

    // Pipeline B left the message, its acceptance and its confirmation in the log
    const self = store.read(GROUP, 0).filter((e) => e.kind.startsWith("self."));
    expect(self.map((e) => (e.kind === "self.send_result" ? e.result : e.kind))).toEqual([
      "self.message",
      "accepted",
      "sent",
    ]);
    // ...and the next run sees it as a sent message of its own
    const state = projection.load(GROUP);
    expect(state.timeline.at(-1)).toMatchObject({ type: "self_message", status: "sent", messageId: "100" });
    expect(store.isSelfMessage(GROUP, "100")).toBe(true);

    const runs = db.orm.select().from(schema.agentRuns).all();
    expect(runs).toMatchObject([{ chat: GROUP, trigger: "mention:m41", status: "completed" }]);
    expect(db.orm.select().from(schema.llmCalls).all()).toHaveLength(2);
    expect(
      db.orm
        .select()
        .from(schema.toolCalls)
        .all()
        .map((c) => [c.name, c.status]),
    ).toEqual([
      ["send_message", "ok"],
      ["end_turn", "ok"],
    ]);
    // The snapshot was written at the end
    expect(db.orm.select().from(schema.chatSnapshots).all()).toHaveLength(1);
  });

  // Regression: the breakpoint sat at the end of the whole timeline, which moves with every message,
  // so every run wrote the cache and none read it
  test("caches the timeline up to its last complete block", async () => {
    for (let i = 1; i <= 23; i++) store.commitInbound(inbound(GROUP, String(i), {}, T0 + i));
    const { provider, requests } = scriptedProvider([[call("end_turn", {})]]);
    await runChat(deps(provider, fakeOutbound().outbound), GROUP, trigger, new AbortController().signal);
    const parts = requests[0]?.messages[0]?.role === "user" ? requests[0].messages[0].parts : [];
    const shown = parts.map((p) =>
      p.type === "text" ? [p.cache === true, p.text.match(/id="m\d+"/g)?.length ?? 0] : [],
    );
    // Blocks of 10 items: two complete, three items still filling up, then now and the trigger
    expect(shown).toEqual([
      [false, 10],
      [true, 10],
      [false, 3],
      [false, 0],
    ]);
    expect(parts[0]?.type === "text" && parts[0].text).toStartWith(
      '<chat type="group" title="Lab"/>\n<timeline>\n',
    );
    expect(requests[0]?.system).not.toContain("Lab");
  });

  test("bad tool calls go back to the model as errors; limits hold", async () => {
    store.commitInbound(inbound(GROUP, "41"));
    const { provider, requests } = scriptedProvider([
      [
        call("send_message", { text: "x".repeat(60), reply_to: null }, "c1"),
        call("send_message", { text: "hi", reply_to: "m999" }, "c2"),
        call("send_message", { reply_to: null }, "c3"),
        call("no_such_tool", {}, "c4"),
      ],
      [
        call("send_message", { text: "one", reply_to: null }, "c5"),
        call("send_message", { text: "two", reply_to: null }, "c6"),
      ],
      [call("send_message", { text: "three", reply_to: null }, "c7")],
      [call("end_turn", {})],
    ]);
    const { outbound, sent } = fakeOutbound([{ ok: false, error: "400: CHAT_WRITE_FORBIDDEN" }]);
    await runChat(deps(provider, outbound), GROUP, trigger, new AbortController().signal);

    const last = requests[1]?.messages.at(-1);
    if (last?.role !== "tool") throw new Error("expected tool results");
    const errors = last.results;
    expect(errors.map((r) => r.isError)).toEqual([true, true, true, true]);
    expect(errors[0]?.content).toContain("limit is 50");
    expect(errors[1]?.content).toContain("no message m999");
    expect(errors[3]?.content).toContain("no tool no_such_tool");
    // Telegram refused "one"; only messages that went out count towards the limit of 2
    expect(sent.map((s) => s.text)).toEqual(["one", "two", "three"]);
    const results = store.read(GROUP, 0).flatMap((e) => (e.kind === "self.send_result" ? [e.result] : []));
    expect(results.filter((r) => r !== "accepted")).toEqual(["failed", "sent", "sent"]);
    expect(
      projection
        .load(GROUP)
        .timeline.filter((i) => i.type === "self_message")
        .map((i) => i.status),
    ).toEqual(["failed", "sent", "sent"]);
  });

  test("a failed model call ends the run as failed and is recorded", async () => {
    store.commitInbound(inbound(GROUP, "41"));
    const provider: LlmProvider = {
      name: "down",
      kind: "messages",
      model: "m",
      complete: (request) => Promise.reject(new LlmError("overloaded", "busy", request)),
    };
    await runChat(deps(provider, fakeOutbound().outbound), GROUP, trigger, new AbortController().signal);
    expect(db.orm.select().from(schema.agentRuns).all()).toMatchObject([{ status: "failed" }]);
    expect(db.orm.select().from(schema.llmCalls).all()).toMatchObject([{ error: "overloaded: busy" }]);
  });
});

describe("createSelfSender.recover", () => {
  test("marks sends left pending as unknown and settles the accepted ones", async () => {
    const outbound = fakeOutbound().outbound;
    let settle: (outcome: SendOutcome) => void = () => {};
    outbound.reconcile = () => new Promise((resolve) => (settle = resolve));
    const message = store.appendSelf(GROUP, "bot", {
      kind: "self.message",
      runId: "r",
      replyTo: null,
      content: text("x"),
    });
    if (!message) throw new Error("not written");
    store.appendSelf(GROUP, "bot", {
      kind: "self.send_result",
      target: message.eventId,
      result: "accepted",
      messageId: null,
      tempId: "5",
      error: null,
    });

    createSelfSender(store, outbound, "bot", log).recover();
    expect(projection.load(GROUP).timeline[0]).toMatchObject({ status: "unknown" });
    settle({ ok: true, messageId: "77", date: 1_800_000_000 });
    await Bun.sleep(0);
    expect(projection.load(GROUP).timeline[0]).toMatchObject({ status: "sent", messageId: "77" });
    expect(store.pendingSends()).toEqual([]);
  });
});

describe("createScheduler", () => {
  function schedule(allowedChats: string[]) {
    const runs: [string, Trigger][] = [];
    let release: () => void = () => {};
    const scheduler = createScheduler(store, {
      allowedChats,
      self: { username: "robin_bot", userKey: "tg:user:900" },
      run: (chat, t) => {
        runs.push([chat, t]);
        return new Promise<void>((resolve) => (release = resolve));
      },
      onFatal: (error) => {
        throw error;
      },
      log,
    });
    return { runs, scheduler, release: () => release() };
  }

  test("private messages, @mentions and replies to Robin trigger; other messages do not", async () => {
    const { runs, scheduler, release } = schedule([GROUP, DM]);
    store.commitInbound(inbound(DM, "1"));
    release();
    await Bun.sleep(0);
    store.commitInbound(inbound(GROUP, "2"));
    const mention = { type: "mention" as const, offset: 3, length: 10 };
    store.commitInbound(
      inbound(
        GROUP,
        "3",
        { content: [{ type: "text", text: "hi @Robin_Bot", entities: [mention] }] },
        T0 + 1,
      ),
    );
    release();
    await Bun.sleep(0);
    const self = store.appendSelf(GROUP, "bot", {
      kind: "self.message",
      runId: "r",
      replyTo: null,
      content: text("x"),
    });
    store.appendSelf(GROUP, "bot", {
      kind: "self.send_result",
      target: self?.eventId ?? "",
      result: "sent",
      messageId: "50",
      tempId: null,
      error: null,
    });
    store.commitInbound(
      inbound(GROUP, "4", { replyTo: { type: "message", messageId: "50", quote: null } }, T0 + 2),
    );
    release();
    await Bun.sleep(0);
    expect(runs.map(([chat, t]) => [chat, t.reason, t.messageId])).toEqual([
      [DM, "private", "1"],
      [GROUP, "mention", "3"],
      [GROUP, "reply", "4"],
    ]);
    await scheduler.stop();
  });

  test("only allowed chats; triggers during a run fold into one follow-up run", async () => {
    const { runs, scheduler, release } = schedule([DM]);
    store.commitInbound(inbound("tg:bot:8", "1"));
    store.commitInbound(inbound(DM, "2"));
    store.commitInbound(inbound(DM, "3", {}, T0 + 1));
    store.commitInbound(inbound(DM, "4", {}, T0 + 2));
    expect(runs.map(([, t]) => t.messageId)).toEqual(["2"]);
    release();
    await Bun.sleep(0);
    expect(runs.map(([, t]) => t.messageId)).toEqual(["2", "4"]);
    release();
    await scheduler.stop();
  });
});
