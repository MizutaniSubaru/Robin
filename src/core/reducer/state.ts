// Chat state: what reduce() builds from one chat's events, i.e. the recent timeline window and the
// users with their aliases. A Zod schema rather than plain types, so a stored
// snapshot is parsed back instead of trusted
import { z } from "zod";

import { Content, MessageId, ReplyRef, UserKey } from "../events/index.ts";

// Bump whenever reduce() would produce a different state from the same events; stored snapshots of
// another version are discarded and the chat is folded again from the start
export const REDUCER_VERSION = 1;

export const WindowConfig = z
  .object({
    // Timeline items kept; beyond this the oldest block is dropped
    maxItems: z.number().int().positive(),
    // Items dropped at once, so the rendered prefix (and the model's prompt cache) changes once per
    // block instead of on every new message
    blockSize: z.number().int().positive(),
  })
  .refine((w) => w.blockSize <= w.maxItems, { message: "blockSize must not exceed maxItems" });
export type WindowConfig = z.infer<typeof WindowConfig>;

const When = {
  // Ordering key of the event that created the item
  ts: z.number().int().positive(),
  // Shown to the model when present: the platform's own time
  serverDate: z.number().int().positive().nullable(),
};

export const MessageItem = z.object({
  type: z.literal("message"),
  eventId: z.string(),
  messageId: MessageId,
  sender: UserKey,
  senderName: z.string(),
  replyTo: ReplyRef.nullable(),
  forwardedFrom: z.string().nullable(),
  content: Content,
  edited: z.boolean(),
  deleted: z.boolean(),
  ...When,
});
export type MessageItem = z.infer<typeof MessageItem>;

export const SelfStatus = z.enum(["sending", "sent", "failed", "unknown"]);
export type SelfStatus = z.infer<typeof SelfStatus>;

export const SelfMessageItem = z.object({
  type: z.literal("self_message"),
  // The self.message event; send results find the item by it
  eventId: z.string(),
  // Known only once sent
  messageId: MessageId.nullable(),
  replyTo: MessageId.nullable(),
  content: Content,
  status: SelfStatus,
  error: z.string().nullable(),
  deleted: z.boolean(),
  ...When,
});
export type SelfMessageItem = z.infer<typeof SelfMessageItem>;

export const RenamedItem = z.object({
  type: z.literal("renamed"),
  eventId: z.string(),
  user: UserKey,
  from: z.string(),
  to: z.string(),
  ...When,
});
export type RenamedItem = z.infer<typeof RenamedItem>;

export const TimelineItem = z.discriminatedUnion("type", [MessageItem, SelfMessageItem, RenamedItem]);
export type TimelineItem = z.infer<typeof TimelineItem>;

export const UserEntry = z.object({ alias: z.string(), name: z.string() });

export const ChatState = z.object({
  chat: z.string(),
  // ts of the last event folded in; 0 before any
  lastTs: z.number().int().nonnegative(),
  window: WindowConfig,
  timeline: z.array(TimelineItem),
  // Items dropped from the front of the timeline so far
  omitted: z.number().int().nonnegative(),
  // Every user the chat has referenced, never trimmed: aliases must stay stable
  users: z.record(UserKey, UserEntry),
});
export type ChatState = z.infer<typeof ChatState>;

export function initialState(chat: string, window: WindowConfig): ChatState {
  return { chat, lastTs: 0, window, timeline: [], omitted: 0, users: {} };
}
