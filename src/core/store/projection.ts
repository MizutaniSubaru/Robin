import { eq } from "drizzle-orm";

import { type Db, schema } from "../../db/index.ts";
import type { Logger } from "../../log/index.ts";
import { ChatState, initialState, REDUCER_VERSION, reduce, type WindowConfig } from "../reducer/index.ts";
import type { EventStore } from "./event-store.ts";

export interface Projection {
  // The chat as of every committed event: the stored snapshot (when still valid) plus the events
  // after it
  load(chat: string): ChatState;
  save(state: ChatState): void;
}

export interface ProjectionOptions {
  window: WindowConfig;
  // Folding at least this many events in one load writes the snapshot right away
  snapshotEvery?: number;
}

export function createProjection(
  db: Db,
  store: EventStore,
  log: Logger,
  options: ProjectionOptions,
): Projection {
  const snapshotEvery = options.snapshotEvery ?? 200;

  function save(state: ChatState): void {
    const row = {
      chat: state.chat,
      lastTs: state.lastTs,
      reducerVersion: REDUCER_VERSION,
      state,
      updatedAt: Date.now(),
    };
    db.orm
      .insert(schema.chatSnapshots)
      .values(row)
      .onConflictDoUpdate({ target: schema.chatSnapshots.chat, set: row })
      .run();
  }

  // A snapshot is a cache: one from another reducer version or window size is folded again
  function start(chat: string): ChatState {
    const row = db.orm.select().from(schema.chatSnapshots).where(eq(schema.chatSnapshots.chat, chat)).get();
    const fresh = initialState(chat, options.window);
    if (!row) return fresh;
    if (row.reducerVersion !== REDUCER_VERSION) {
      log.info("Refolding {chat}: snapshot is from reducer {version}", { chat, version: row.reducerVersion });
      return fresh;
    }
    const state = ChatState.parse(row.state);
    if (
      state.window.maxItems !== options.window.maxItems ||
      state.window.blockSize !== options.window.blockSize
    ) {
      log.info("Refolding {chat}: window changed", { chat });
      return fresh;
    }
    return state;
  }

  return {
    load(chat) {
      const base = start(chat);
      const events = store.read(chat, base.lastTs);
      const state = reduce(base, events);
      if (events.length >= snapshotEvery) save(state);
      return state;
    },
    save,
  };
}
