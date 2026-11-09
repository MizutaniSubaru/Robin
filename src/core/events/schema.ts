// Robin's own events: the append-only log is the source of truth, everything else is derived from it.
// Platform-neutral: identifiers are opaque keys built by the source adapter (see keys.ts).
import { z } from "zod";

// Keys are opaque outside the adapter that builds them; core only compares them
export const ChatKey = z.string().min(1);
export const UserKey = z.string().min(1);
// A message id within its chat, as the platform numbers it (Telegram: the server id)
export const MessageId = z.string().regex(/^\d+$/);

// Formatting the model or the renderer needs; plain decorations (bold, italic, ...) are kept so a
// message can be shown faithfully, auto-detected ones (urls, hashtags) are left to the text itself.
// Offsets and lengths count UTF-16 code units, as JS strings do
const span = { offset: z.number().int().nonnegative(), length: z.number().int().positive() };
export const TextEntity = z.discriminatedUnion("type", [
  z.object({
    type: z.enum([
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "spoiler",
      "code",
      "blockquote",
      "mention",
    ]),
    ...span,
  }),
  z.object({ type: z.literal("pre"), language: z.string(), ...span }),
  z.object({ type: z.literal("text_url"), url: z.string(), ...span }),
  // A mention that links a user without showing their username
  z.object({ type: z.literal("mention_user"), user: UserKey, ...span }),
]);
export type TextEntity = z.infer<typeof TextEntity>;

export const ContentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), entities: z.array(TextEntity) }),
  z.object({ type: z.literal("sticker"), emoji: z.string() }),
  // Content Robin does not understand yet (photo, voice, poll, ...). Kept as a placeholder so the
  // timeline shows that something was sent; re-adapting raw updates fills it in later
  z.object({ type: z.literal("unsupported"), kind: z.string().min(1) }),
]);
export type ContentPart = z.infer<typeof ContentPart>;

export const Content = z.array(ContentPart).min(1);
export type Content = z.infer<typeof Content>;

export const ReplyRef = z.discriminatedUnion("type", [
  // quote: the part of the target the sender picked, null when replying to the whole message
  z.object({ type: z.literal("message"), messageId: MessageId, quote: z.string().nullable() }),
  // A reply to a message in another chat; only the quoted text is known
  z.object({ type: z.literal("external"), quote: z.string().nullable() }),
]);
export type ReplyRef = z.infer<typeof ReplyRef>;

export const SendResult = z.enum([
  // The platform took the message and gave it a temporary id (used to reconcile after a crash)
  "accepted",
  "sent",
  "failed",
  // Still pending when Robin restarted; may later turn into sent / failed
  "unknown",
]);
export type SendResult = z.infer<typeof SendResult>;

// One schema per kind: the fields a producer supplies. The store adds EventMeta
export const EventBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message.created"),
    messageId: MessageId,
    sender: UserKey,
    // Frozen at the time of the message, so later renames never rewrite rendered history
    senderName: z.string(),
    replyTo: ReplyRef.nullable(),
    // Display name of the original author when forwarded
    forwardedFrom: z.string().nullable(),
    content: Content,
  }),
  z.object({ kind: z.literal("message.edited"), messageId: MessageId, content: Content }),
  z.object({ kind: z.literal("message.deleted"), messageId: MessageId }),
  // Derived by the store the first time a user is referenced in a chat; never changes afterwards
  z.object({
    kind: z.literal("alias.assigned"),
    user: UserKey,
    alias: z.string().regex(/^u\d+$/),
    name: z.string(),
  }),
  // Derived by the store when a known user's name changes
  z.object({ kind: z.literal("user.renamed"), user: UserKey, from: z.string(), to: z.string() }),
  // Pipeline B: written before the platform call, so a crash never loses a message that went out
  z.object({
    kind: z.literal("self.message"),
    runId: z.string().min(1),
    replyTo: MessageId.nullable(),
    content: Content,
  }),
  z.object({
    kind: z.literal("self.send_result"),
    // eventId of the self.message
    target: z.string().min(1),
    result: SendResult,
    // Set once sent
    messageId: MessageId.nullable(),
    // Set when accepted
    tempId: z.string().nullable(),
    error: z.string().nullable(),
  }),
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventKind = EventBody["kind"];
export type BodyOf<K extends EventKind> = Extract<EventBody, { kind: K }>;

export const TsSource = z.enum(["local", "server"]);

// Who produced an event: a source account, or "robin" for events the store derives itself
export const Account = z.string().min(1);

export const EventMeta = z.object({
  eventId: z.string().min(1),
  chat: ChatKey,
  account: Account,
  // µs, strictly increasing for live events; the only ordering key (ties broken by row id)
  ts: z.number().int().positive(),
  tsSource: TsSource,
  // Platform time in seconds when the platform gives one; shown to the model instead of ts
  serverDate: z.number().int().positive().nullable(),
});
export type EventMeta = z.infer<typeof EventMeta>;

export type RobinEvent = EventMeta & EventBody;
export type EventOf<K extends EventKind> = EventMeta & BodyOf<K>;

export function parseEvent(meta: unknown, body: unknown): RobinEvent {
  return { ...EventMeta.parse(meta), ...EventBody.parse(body) };
}

// Idempotency within a chat (UNIQUE(chat, dedup_key)); null means every copy is kept
export function dedupKeyOf(body: EventBody, serverDate: number | null): string | null {
  switch (body.kind) {
    case "message.created":
      return `msg:${body.messageId}`;
    case "message.edited":
      // Every edit has its own edit date; without one two edits could not be told apart
      if (serverDate === null) throw new Error(`message.edited ${body.messageId} has no edit date`);
      return `edit:${body.messageId}:${serverDate}`;
    case "message.deleted":
      return `del:${body.messageId}`;
    case "alias.assigned":
      return `alias:${body.user}`;
    case "self.send_result":
      return `send:${body.target}:${body.result}`;
    case "user.renamed":
    case "self.message":
      return null;
  }
}

// Self events never trigger a run: Robin must not answer itself
export function isSelfEvent(event: EventBody): boolean {
  return event.kind === "self.message" || event.kind === "self.send_result";
}
