import type { ReplyRef } from "../events/index.ts";
import type { ChatState, MessageItem, SelfMessageItem, TimelineItem } from "../reducer/index.ts";
import { type AliasOf, renderContent } from "./text.ts";
import { attrs, escapeText } from "./xml.ts";

export interface RenderOptions {
  // IANA timezone for every date and time shown
  timezone: string;
}

// The chat as the model reads it: one line per item, oldest first, with a <day> line whenever the
// date changes. Pure, and it reads only the state: whatever has been rendered once renders the same
// way again (until an edit, deletion, send result or window trim touches it), which keeps the
// model's prompt cache valid across runs
export function renderTimeline(state: ChatState, options: RenderOptions): string {
  return renderTimelineBlocks(state, options)
    .map((block) => block.text)
    .join("\n");
}

export interface TimelineBlock {
  text: string;
  // Holds a whole window block: it changes only when an item in it is edited, deleted or settled
  complete: boolean;
}

// The timeline cut where the window trims, every blockSize items counted from the start of the chat
// (the window only ever drops whole blocks, so the cuts never move). A complete block is the same
// text from run to run, which is what a prompt cache breakpoint needs; only the last block grows
export function renderTimelineBlocks(state: ChatState, options: RenderOptions): TimelineBlock[] {
  const clock = createClock(options.timezone);
  const aliasOf = aliasesOf(state);
  const { blockSize } = state.window;

  const blocks: TimelineBlock[] = [];
  let lines: string[] = state.omitted > 0 ? [`<omitted${attrs({ items: state.omitted })}/>`] : [];
  let lastDate: string | undefined;
  state.timeline.forEach((item, i) => {
    if (i > 0 && i % blockSize === 0) {
      blocks.push({ text: lines.join("\n"), complete: true });
      lines = [];
    }
    const at = clock(displayMs(item));
    if (at.date !== lastDate) {
      lines.push(`<day${attrs({ date: at.date, weekday: at.weekday })}/>`);
      lastDate = at.date;
    }
    lines.push(renderItem(item, at.time, aliasOf));
  });
  if (lines.length > 0) {
    const inLast = state.timeline.length - blocks.length * blockSize;
    blocks.push({ text: lines.join("\n"), complete: inLast === blockSize });
  }
  return blocks;
}

// What a run has not seen yet: the items of `now` that are new since `seen` or render differently
// (edited, deleted, renamed), each as it reads now. Robin's own messages are left out: the run sent
// them and knows. undefined when nothing changed
export function renderUpdate(seen: ChatState, now: ChatState, options: RenderOptions): string | undefined {
  const clock = createClock(options.timezone);
  const line = (item: TimelineItem, aliasOf: AliasOf) =>
    renderItem(item, clock(displayMs(item)).time, aliasOf);
  const seenAliases = aliasesOf(seen);
  const nowAliases = aliasesOf(now);
  const before = new Map(seen.timeline.map((item) => [item.eventId, line(item, seenAliases)]));
  const lines: string[] = [];
  let lastDate: string | undefined;
  for (const item of now.timeline) {
    if (item.type === "self_message") continue;
    const text = line(item, nowAliases);
    if (before.get(item.eventId) === text) continue;
    const at = clock(displayMs(item));
    if (at.date !== lastDate) {
      lines.push(`<day${attrs({ date: at.date, weekday: at.weekday })}/>`);
      lastDate = at.date;
    }
    lines.push(text);
  }
  return lines.length > 0 ? `<update>\n${lines.join("\n")}\n</update>` : undefined;
}

// Appended after the timeline on every run, outside the cached prefix
export function renderNow(nowMs: number, options: RenderOptions): string {
  const at = createClock(options.timezone)(nowMs);
  return `<now${attrs({ date: at.date, weekday: at.weekday, time: at.time, tz: options.timezone })}/>`;
}

// The chat itself. Its title is chosen by its members, so it is shown like any other user text:
// as escaped data in the timeline, never in the instructions
export function renderChat(chat: { kind: "private" | "group"; title: string | null }): string {
  return `<chat${attrs({ type: chat.kind, title: chat.title ?? undefined })}/>`;
}

export function messageAlias(messageId: string): string {
  return `m${messageId}`;
}

// The inverse of messageAlias, for ids the model passes to tools
export function parseMessageAlias(alias: string): string | undefined {
  return /^m(\d+)$/.exec(alias)?.[1];
}

function aliasesOf(state: ChatState): AliasOf {
  return (user) => {
    const entry = state.users[user];
    if (!entry) throw new Error(`User ${user} has no alias in ${state.chat}`);
    return entry.alias;
  };
}

function renderItem(item: TimelineItem, time: string, aliasOf: AliasOf): string {
  switch (item.type) {
    case "message":
      return renderMessage(item, time, aliasOf);
    case "self_message":
      return renderSelf(item, time, aliasOf);
    case "renamed":
      return `<event${attrs({ type: "renamed", user: aliasOf(item.user), from: item.from, to: item.to, time })}/>`;
  }
}

function renderMessage(item: MessageItem, time: string, aliasOf: AliasOf): string {
  const head = attrs({
    id: messageAlias(item.messageId),
    from: aliasOf(item.sender),
    name: item.senderName,
    time,
    ...replyAttrs(item.replyTo),
    forwarded_from: item.forwardedFrom ?? undefined,
    edited: item.edited,
    deleted: item.deleted,
  });
  // A deleted message keeps its place but not its content
  if (item.deleted) return `<message${head}/>`;
  return `<message${head}>${quote(item.replyTo)}${renderContent(item.content, aliasOf)}</message>`;
}

function renderSelf(item: SelfMessageItem, time: string, aliasOf: AliasOf): string {
  const head = attrs({
    // Only a sent message can be referred to
    id: item.messageId === null ? undefined : messageAlias(item.messageId),
    from: "self",
    time,
    reply_to: item.replyTo === null ? undefined : messageAlias(item.replyTo),
    status: selfStatus(item),
    deleted: item.deleted,
  });
  if (item.deleted) return `<message${head}/>`;
  return `<message${head}>${renderContent(item.content, aliasOf)}</message>`;
}

function selfStatus(item: SelfMessageItem): string | undefined {
  switch (item.status) {
    case "sent":
      return undefined;
    case "sending":
      return "sending";
    case "failed":
      return "failed";
    // Robin restarted mid-send: the message may or may not have gone out
    case "unknown":
      return "maybe_sent";
  }
}

function replyAttrs(replyTo: ReplyRef | null): Record<string, string | boolean> {
  if (replyTo === null) return {};
  switch (replyTo.type) {
    case "message":
      return { reply_to: messageAlias(replyTo.messageId) };
    case "external":
      return { reply_to_other_chat: true };
  }
}

// A reply that picked part of the target shows that part; a whole-message reply shows nothing extra
function quote(replyTo: ReplyRef | null): string {
  if (replyTo?.quote == null) return "";
  return `<quote>${escapeText(replyTo.quote)}</quote>`;
}

function displayMs(item: TimelineItem): number {
  return item.serverDate === null ? Math.floor(item.ts / 1000) : item.serverDate * 1000;
}

interface ClockReading {
  date: string;
  weekday: string;
  time: string;
}

function createClock(timezone: string): (ms: number) => ClockReading {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return (ms) => {
    const parts = Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, p.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      weekday: String(parts.weekday),
      time: `${parts.hour}:${parts.minute}:${parts.second}`,
    };
  };
}
