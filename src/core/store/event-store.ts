// Event store: the only code that writes the events table. Commits inbound and self events, assigns
// their eventId and ts, drops duplicates and notifies listeners of every commit. Also keeps the chats
// table (chat type and title)

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { type Db, schema } from "../../db/index.ts";
import type { Logger } from "../../log/index.ts";
import {
  type ContentPart,
  dedupKeyOf,
  type EventBody,
  type EventMeta,
  parseEvent,
  type RobinEvent,
} from "../events/index.ts";
import { createTsClock, nowUs, type TsClock } from "./clock.ts";
import type { ChatType, InboundChat, InboundEvent, InboundProfile, SelfBody } from "./types.ts";

type EventRow = typeof schema.events.$inferSelect;

export type CommitListener = (events: readonly RobinEvent[]) => void;

// Account of the events the store derives itself
export const DERIVED_ACCOUNT = "robin";

export interface PendingSend {
  chat: string;
  // eventId of the self.message
  eventId: string;
  // From the "accepted" result, if the platform got that far
  tempId: string | null;
}

export interface EventStore {
  // Commits one inbound event with whatever it implies (aliases for new users, renames), in one
  // transaction. Returns what was written; a duplicate writes nothing
  commitInbound(item: InboundEvent): RobinEvent[];
  commitProfile(item: InboundProfile, chat: string): RobinEvent[];
  // Chats where the user has an alias, i.e. where a rename has to be recorded
  chatsKnowing(user: string): string[];
  // Pipeline B: written synchronously, outside the inbound queues, before the platform call.
  // undefined when deduplicated
  appendSelf(
    chat: string,
    account: string,
    body: SelfBody,
    serverDate?: number | null,
  ): RobinEvent | undefined;
  upsertChat(chat: InboundChat): void;
  chatInfo(chat: string): { type: ChatType; title: string | null } | undefined;
  // Events after afterTs, in log order
  read(chat: string, afterTs: number): RobinEvent[];
  // Self messages whose send never reached a final state
  pendingSends(): PendingSend[];
  isSelfMessage(chat: string, messageId: string): boolean;
  onCommit(listener: CommitListener): () => void;
}

interface KnownUser {
  alias: string;
  name: string;
}

// Derives alias.assigned / user.renamed from what each inbound event references, so aliases are
// events too: stable across any refold, never renumbered
export function createEventStore(db: Db, log: Logger): EventStore {
  const listeners = new Set<CommitListener>();
  const clock: TsClock = createTsClock(maxTs(db), (byUs) =>
    log.warn("Event ts raised {byUs} µs above its receive time", { byUs }),
  );
  // chat -> user -> alias and current name, rebuilt from the log
  const directory = loadDirectory(db);

  function known(chat: string): Map<string, KnownUser> {
    let users = directory.get(chat);
    if (!users) {
      users = new Map();
      directory.set(chat, users);
    }
    return users;
  }

  // Inserts in order; returns the rows actually written
  function insert(rows: (EventMeta & EventBody)[]): RobinEvent[] {
    const written: RobinEvent[] = [];
    for (const event of rows) {
      const { eventId, chat, account, ts, tsSource, serverDate, kind, ...payload } = event;
      const inserted = db.orm
        .insert(schema.events)
        .values({
          eventId,
          chat,
          account,
          ts,
          tsSource,
          serverDate,
          kind,
          dedupKey: dedupKeyOf(event),
          payload,
        })
        .onConflictDoNothing()
        .returning({ id: schema.events.id })
        .all();
      if (inserted.length > 0) written.push(event);
    }
    return written;
  }

  function event(
    chat: string,
    account: string,
    body: EventBody,
    hintUs: number,
    serverDate: number | null,
  ): EventMeta & EventBody {
    return {
      eventId: Bun.randomUUIDv7(),
      chat,
      account,
      ts: clock.next(hintUs),
      tsSource: "local",
      serverDate,
      ...body,
    };
  }

  // Aliases and renames for users the body references, ahead of the body itself
  function derive(
    chat: string,
    users: Readonly<Record<string, string>>,
    hintUs: number,
    serverDate: number | null,
  ) {
    const table = known(chat);
    const derived: (EventMeta & EventBody)[] = [];
    // The table learns the new aliases only after the commit, so number them here
    let assigned = table.size;
    for (const [user, name] of Object.entries(users)) {
      const entry = table.get(user);
      if (!entry) {
        const alias = `u${++assigned}`;
        derived.push(
          event(chat, DERIVED_ACCOUNT, { kind: "alias.assigned", user, alias, name }, hintUs, null),
        );
      } else if (entry.name !== name) {
        derived.push(
          event(
            chat,
            DERIVED_ACCOUNT,
            { kind: "user.renamed", user, from: entry.name, to: name },
            hintUs,
            serverDate,
          ),
        );
      }
    }
    return derived;
  }

  // The directory follows only what was written, after the transaction commits
  function remember(written: readonly RobinEvent[]): void {
    for (const e of written) {
      if (e.kind === "alias.assigned") known(e.chat).set(e.user, { alias: e.alias, name: e.name });
      if (e.kind === "user.renamed") {
        const entry = known(e.chat).get(e.user);
        if (entry) entry.name = e.to;
      }
    }
  }

  function commit(build: () => (EventMeta & EventBody)[]): RobinEvent[] {
    const written = db.orm.transaction(() => insert(build()));
    remember(written);
    if (written.length > 0) for (const listener of listeners) listener(written);
    return written;
  }

  return {
    commitInbound(item) {
      return commit(() => {
        // A duplicate (already committed) must not derive anything either
        const key = dedupKeyOf(item.body);
        if (key !== null && hasDedupKey(db, item.chat, key)) return [];
        // Skip phantom edits (e.g. a link-preview refresh followed by a markup-only edit with an old
        // edit_date) whose visible content did not change, and inbound edits of Robin's own messages
        if (item.body.kind === "message.edited") {
          if (hasSelfMessage(db, item.chat, item.body.messageId)) return [];
          const previous = latestMessageContent(db, item.chat, item.body.messageId);
          if (previous !== undefined && Bun.deepEquals(previous, item.body.content, true)) return [];
        }
        const derived = derive(item.chat, referenced(item), item.receivedAt, item.serverDate);
        return [...derived, event(item.chat, item.account, item.body, item.receivedAt, item.serverDate)];
      });
    },
    commitProfile(item, chat) {
      return commit(() =>
        known(chat).has(item.user) ? derive(chat, { [item.user]: item.name }, item.receivedAt, null) : [],
      );
    },
    chatsKnowing(user) {
      return [...directory].filter(([, users]) => users.has(user)).map(([chat]) => chat);
    },
    appendSelf(chat, account, body, serverDate = null) {
      return commit(() => [event(chat, account, body, nowUs(), serverDate)])[0];
    },
    upsertChat({ chat, chatType, title, inboundAccount }) {
      db.orm
        .insert(schema.chats)
        .values({ chat, type: chatType, title, inboundAccount })
        .onConflictDoUpdate({ target: schema.chats.chat, set: { type: chatType, title, inboundAccount } })
        .run();
    },
    chatInfo(chat) {
      const row = db.orm.select().from(schema.chats).where(eq(schema.chats.chat, chat)).get();
      return row ? { type: row.type, title: row.title } : undefined;
    },
    read(chat, afterTs) {
      return db.orm
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.chat, chat), gt(schema.events.ts, afterTs)))
        .orderBy(asc(schema.events.ts), asc(schema.events.id))
        .all()
        .map(toEvent);
    },
    pendingSends() {
      const self = db.orm
        .select()
        .from(schema.events)
        .where(inArray(schema.events.kind, ["self.message", "self.send_result"]))
        .orderBy(asc(schema.events.ts), asc(schema.events.id))
        .all()
        .map(toEvent);
      const open = new Map<string, PendingSend>();
      for (const e of self) {
        if (e.kind === "self.message")
          open.set(e.eventId, { chat: e.chat, eventId: e.eventId, tempId: null });
        if (e.kind !== "self.send_result") continue;
        const entry = open.get(e.target);
        if (!entry) continue;
        if (e.result === "accepted") entry.tempId = e.tempId;
        else open.delete(e.target);
      }
      return [...open.values()];
    },
    isSelfMessage(chat, messageId) {
      return hasSelfMessage(db, chat, messageId);
    },
    onCommit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// Every user an inbound event names: its sender and anyone mentioned in its text
function referenced(item: InboundEvent): Readonly<Record<string, string>> {
  const users = item.users;
  const needed = new Set<string>();
  if (item.body.kind === "message.created") needed.add(item.body.sender);
  if (item.body.kind !== "message.deleted")
    for (const user of mentionedUsers(item.body.content)) needed.add(user);
  const out: Record<string, string> = {};
  for (const user of needed) {
    const name = users[user];
    if (name === undefined) throw new Error(`Inbound ${item.body.kind} references ${user} without a name`);
    out[user] = name;
  }
  return out;
}

function mentionedUsers(content: readonly ContentPart[]): string[] {
  return content.flatMap((part) =>
    part.type === "text" ? part.entities.flatMap((e) => (e.type === "mention_user" ? [e.user] : [])) : [],
  );
}

function toEvent(row: EventRow): RobinEvent {
  return parseEvent(
    {
      eventId: row.eventId,
      chat: row.chat,
      account: row.account,
      ts: row.ts,
      tsSource: row.tsSource,
      serverDate: row.serverDate,
    },
    { ...row.payload, kind: row.kind },
  );
}

function maxTs(db: Db): number {
  const row = db.orm
    .select({ ts: sql<number | null>`max(${schema.events.ts})` })
    .from(schema.events)
    .get();
  return row?.ts ?? 0;
}

function hasDedupKey(db: Db, chat: string, dedupKey: string): boolean {
  return (
    db.orm
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(and(eq(schema.events.chat, chat), eq(schema.events.dedupKey, dedupKey)))
      .limit(1)
      .all().length > 0
  );
}

function hasSelfMessage(db: Db, chat: string, messageId: string): boolean {
  return (
    db.orm
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.chat, chat),
          eq(schema.events.kind, "self.send_result"),
          sql`json_extract(${schema.events.payload}, '$.messageId') = ${messageId}`,
        ),
      )
      .limit(1)
      .all().length > 0
  );
}

function latestMessageContent(db: Db, chat: string, messageId: string): unknown {
  const row = db.orm
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.chat, chat),
        inArray(schema.events.kind, ["message.created", "message.edited"]),
        sql`json_extract(${schema.events.payload}, '$.messageId') = ${messageId}`,
      ),
    )
    .orderBy(desc(schema.events.ts), desc(schema.events.id))
    .limit(1)
    .get();
  return row?.payload.content;
}

function loadDirectory(db: Db): Map<string, Map<string, KnownUser>> {
  const directory = new Map<string, Map<string, KnownUser>>();
  const rows = db.orm
    .select()
    .from(schema.events)
    .where(inArray(schema.events.kind, ["alias.assigned", "user.renamed"]))
    .orderBy(asc(schema.events.ts), asc(schema.events.id))
    .all()
    .map(toEvent);
  for (const e of rows) {
    let users = directory.get(e.chat);
    if (!users) {
      users = new Map();
      directory.set(e.chat, users);
    }
    if (e.kind === "alias.assigned") users.set(e.user, { alias: e.alias, name: e.name });
    if (e.kind === "user.renamed") {
      const entry = users.get(e.user);
      if (entry) entry.name = e.to;
    }
  }
  return directory;
}
