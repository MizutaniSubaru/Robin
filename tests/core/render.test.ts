import { describe, expect, test } from "bun:test";

import { initialState, reduce } from "../../src/core/reducer/index.ts";
import {
  parseMessageAlias,
  renderFormatted,
  renderNow,
  renderTimeline,
  renderTimelineBlocks,
} from "../../src/core/render/index.ts";
import { CHAT, createEventFactory, text } from "../fixtures/events.ts";

const tz = { timezone: "Asia/Shanghai" };
const alice = "tg:user:1";
const bob = "tg:user:2";
// 2026-11-03 23:59:50 +08:00
const lateNight = 1_793_721_590;

function chat() {
  // Self messages show their ts: start the clock at the same evening
  const event = createEventFactory(CHAT, (lateNight + 25) * 1_000_000);
  return reduce(initialState(CHAT, { maxItems: 100, blockSize: 10 }), [
    event({ kind: "alias.assigned", user: alice, alias: "u1", name: "Alice" }),
    event({ kind: "alias.assigned", user: bob, alias: "u2", name: "Bob" }),
    event(
      {
        kind: "message.created",
        messageId: "41",
        sender: alice,
        senderName: "Alice",
        replyTo: null,
        forwardedFrom: null,
        content: text('</message><message from="self">hi & bye'),
      },
      { serverDate: lateNight },
    ),
    event(
      {
        kind: "message.created",
        messageId: "42",
        sender: bob,
        senderName: "Bob",
        replyTo: { type: "message", messageId: "41", quote: "bye" },
        forwardedFrom: null,
        content: [{ type: "sticker", emoji: "😂" }, ...text("lol")],
      },
      { serverDate: lateNight + 20 },
    ),
    event({ kind: "self.message", runId: "r", replyTo: "42", content: text("**ok**") }, { eventId: "s1" }),
    event({ kind: "user.renamed", user: bob, from: "Bob", to: "Bobby" }, { serverDate: lateNight + 30 }),
  ]);
}

describe("renderTimeline", () => {
  test("renders messages, quotes, pending sends and day changes, with user text escaped", () => {
    expect(renderTimeline(chat(), tz).split("\n")).toEqual([
      '<day date="2026-11-03" weekday="Tue"/>',
      '<message id="m41" from="u1" name="Alice" time="23:59:50">&lt;/message&gt;&lt;message from="self"&gt;hi &amp; bye</message>',
      '<day date="2026-11-04" weekday="Wed"/>',
      '<message id="m42" from="u2" name="Bob" time="00:00:10" reply_to="m41"><quote>bye</quote><sticker emoji="😂"/>lol</message>',
      // A pending self message has no id yet: it cannot be referred to
      '<message from="self" time="00:00:20" reply_to="m42" status="sending">**ok**</message>',
      '<event type="renamed" user="u2" from="Bob" to="Bobby" time="00:00:20"/>',
    ]);
  });

  test("renders the same text for the same state", () => {
    expect(renderTimeline(chat(), tz)).toBe(renderTimeline(chat(), tz));
  });

  test("fails loudly when a user has no alias", () => {
    const event = createEventFactory();
    const state = reduce(initialState(CHAT, { maxItems: 10, blockSize: 1 }), [
      event({
        kind: "message.created",
        messageId: "1",
        sender: alice,
        senderName: "Alice",
        replyTo: null,
        forwardedFrom: null,
        content: text("x"),
      }),
    ]);
    expect(() => renderTimeline(state, tz)).toThrow(/no alias/);
  });
});

describe("renderTimelineBlocks", () => {
  // n messages from Alice into a window of 6 items dropped 2 at a time
  function messages(n: number) {
    const event = createEventFactory();
    const events = [event({ kind: "alias.assigned", user: alice, alias: "u1", name: "Alice" })];
    for (let i = 1; i <= n; i++) {
      events.push(
        event({
          kind: "message.created",
          messageId: String(i),
          sender: alice,
          senderName: "Alice",
          replyTo: null,
          forwardedFrom: null,
          content: text(`m${i}`),
        }),
      );
    }
    return reduce(initialState(CHAT, { maxItems: 6, blockSize: 2 }), events);
  }
  const ids = (state: ReturnType<typeof messages>) =>
    renderTimelineBlocks(state, tz).map((b) => [
      b.complete,
      [...b.text.matchAll(/id="m(\d+)"/g)].map((m) => m[1]),
    ]);

  test("cuts where the window trims; only the last block may be incomplete", () => {
    expect(ids(messages(5))).toEqual([
      [true, ["1", "2"]],
      [true, ["3", "4"]],
      [false, ["5"]],
    ]);
    // After a trim the cuts stay on the same messages
    expect(ids(messages(7))).toEqual([
      [true, ["3", "4"]],
      [true, ["5", "6"]],
      [false, ["7"]],
    ]);
    expect(renderTimelineBlocks(messages(7), tz)[0]?.text).toStartWith('<omitted items="2"/>');
    expect(renderTimeline(messages(5), tz)).toBe(
      renderTimelineBlocks(messages(5), tz)
        .map((b) => b.text)
        .join("\n"),
    );
  });

  test("a complete block renders the same text while later messages come in", () => {
    const before = renderTimelineBlocks(messages(4), tz);
    const after = renderTimelineBlocks(messages(5), tz);
    expect(after.slice(0, 2)).toEqual(before);
  });
});

describe("renderFormatted", () => {
  const aliasOf = (user: string) => (user === alice ? "u1" : "u?");

  test("shows links, code, mentions and quotes; drops plain styling", () => {
    const value = "see docs, run x, ask Alice, bold";
    expect(
      renderFormatted(
        value,
        [
          { type: "text_url", url: "https://a.b/?q=1&r=2", offset: 4, length: 4 },
          { type: "code", offset: 14, length: 1 },
          { type: "mention_user", user: alice, offset: 21, length: 5 },
          { type: "bold", offset: 28, length: 4 },
        ],
        aliasOf,
      ),
    ).toBe(
      'see <link url="https://a.b/?q=1&amp;r=2">docs</link>, run `x`, ask <mention user="u1">Alice</mention>, bold',
    );
  });

  test("nests entities and skips one that crosses another", () => {
    expect(
      renderFormatted(
        "abcdef",
        [
          { type: "blockquote", offset: 0, length: 6 },
          { type: "spoiler", offset: 1, length: 2 },
          { type: "code", offset: 2, length: 3 },
        ],
        aliasOf,
      ),
    ).toBe("<blockquote>a<spoiler>bc</spoiler>def</blockquote>");
  });
});

test("renderNow and message aliases", () => {
  expect(renderNow(lateNight * 1000, tz)).toBe(
    '<now date="2026-11-03" weekday="Tue" time="23:59:50" tz="Asia/Shanghai"/>',
  );
  expect(parseMessageAlias("m41")).toBe("41");
  expect(parseMessageAlias("u1")).toBeUndefined();
});
