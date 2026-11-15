// Inbound queues: where sources hand their items over to the store. Each chat has its own queue, so
// events are committed in the order they arrived

import type { Logger } from "../../log/index.ts";
import type { EventStore } from "./event-store.ts";
import type { InboundEvent, InboundItem, InboundProfile } from "./types.ts";

// Inbound work for one chat. Profiles fan out to one entry per chat that knows the user
type Queued = { chat: string; item: InboundEvent } | { chat: string; item: InboundProfile };

export interface InboundOptions {
  // Asynchronous preparation before commit (downloads, descriptions). Runs in parallel, possibly out
  // of order; commits still follow arrival order. Plain text needs none
  transform?(item: InboundEvent): Promise<InboundEvent>;
  // A transform that keeps failing for this long is given up: the event is committed as it came,
  // because one broken item must not block its chat forever
  giveUpAfterMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  // A commit failed: the database is unusable. The caller should exit
  onFatal(error: Error): void;
}

export interface Inbound {
  accept(item: InboundItem): void;
  // Resolves once every accepted item has been committed
  idle(): Promise<void>;
  // Stops accepting and waits for what is queued
  close(): Promise<void>;
}

interface Entry {
  queued: Queued;
  ready: Queued | undefined;
}

// Only the head of a chat's queue commits, and only once its transform is done, so every chat's
// events are committed (and get their ts) in arrival order, while a slow transform in one chat never
// holds up another
export function createInbound(store: EventStore, log: Logger, options: InboundOptions): Inbound {
  const transform = options.transform ?? ((item: InboundEvent) => Promise.resolve(item));
  const giveUpAfterMs = options.giveUpAfterMs ?? 120_000;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const retryMaxMs = options.retryMaxMs ?? 30_000;

  const queues = new Map<string, Entry[]>();
  const idleWaiters = new Set<() => void>();
  let size = 0;
  let closed = false;
  let failed = false;

  function push(queued: Queued): void {
    const entry: Entry = { queued, ready: undefined };
    const queue = queues.get(queued.chat) ?? [];
    queue.push(entry);
    queues.set(queued.chat, queue);
    size++;
    if (queued.item.type === "profile") {
      entry.ready = queued;
      queueMicrotask(() => drain(queued.chat));
    } else {
      prepare(entry, queued.item, Date.now(), 0);
    }
  }

  function prepare(entry: Entry, item: InboundEvent, startedAt: number, attempt: number): void {
    transform(item).then(
      (done) => {
        entry.ready = { chat: entry.queued.chat, item: done };
        drain(entry.queued.chat);
      },
      (error: unknown) => {
        if (failed) return;
        if (Date.now() - startedAt >= giveUpAfterMs) {
          log.error("Giving up preparing {kind} in {chat}; committing it as received", {
            kind: item.body.kind,
            chat: item.chat,
            error,
          });
          entry.ready = entry.queued;
          drain(entry.queued.chat);
          return;
        }
        const delayMs = Math.min(retryMaxMs, retryBaseMs * 2 ** attempt);
        log.warn("Preparing {kind} in {chat} failed, retrying in {delayMs} ms", {
          kind: item.body.kind,
          chat: item.chat,
          delayMs,
          error,
        });
        setTimeout(() => prepare(entry, item, startedAt, attempt + 1), delayMs);
      },
    );
  }

  function drain(chat: string): void {
    const queue = queues.get(chat);
    while (!failed && queue?.[0]?.ready) {
      const { item } = queue[0].ready;
      try {
        if (item.type === "event") store.commitInbound(item);
        else store.commitProfile(item, chat);
      } catch (error) {
        failed = true;
        options.onFatal(new Error(`Failed to commit inbound ${chat}`, { cause: error }));
        return;
      }
      queue.shift();
      size--;
    }
    if (queue?.length === 0) queues.delete(chat);
    if (size === 0) for (const waiter of [...idleWaiters]) waiter();
  }

  function idle(): Promise<void> {
    if (size === 0 || failed) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = () => {
        idleWaiters.delete(waiter);
        resolve();
      };
      idleWaiters.add(waiter);
    });
  }

  return {
    accept(item) {
      if (closed) throw new Error(`Inbound ${item.type} accepted after close`);
      switch (item.type) {
        case "chat":
          store.upsertChat(item);
          return;
        case "event":
          push({ chat: item.chat, item });
          return;
        // A chat that only learns the user from an event still queued gets the name that event
        // carries; its next message corrects it if the profile changed meanwhile
        case "profile":
          for (const chat of store.chatsKnowing(item.user)) push({ chat, item });
          return;
      }
    },
    idle,
    async close() {
      closed = true;
      await idle();
    },
  };
}
