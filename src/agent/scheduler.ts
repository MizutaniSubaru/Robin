import type { RobinEvent } from "../core/events/index.ts";
import { DERIVED_ACCOUNT, type EventStore } from "../core/store/index.ts";
import type { Logger } from "../log/index.ts";
import type { Trigger } from "./run.ts";

export interface SchedulerOptions {
  allowedChats: readonly string[];
  // How the bot is addressed: @username in text, or a mention of its user key
  self: { username: string | undefined; userKey: string };
  run(chat: string, trigger: Trigger, signal: AbortSignal): Promise<void>;
  // A run failed with something other than a model error: a bug or a broken database
  onFatal(error: Error): void;
  log: Logger;
}

export interface Scheduler {
  stop(): Promise<void>;
}

interface ChatRuns {
  running: Promise<void>;
  // Triggers that came in during the run: one more run afterwards covers them all
  next: Trigger | undefined;
}

const STOP_WAIT_MS = 10_000;

// Starts runs: in private chats on every message, in groups when Robin is mentioned or replied to.
// Robin's own events never trigger anything. Runs of one chat never overlap; triggers arriving
// meanwhile fold into a single follow-up run
export function createScheduler(store: EventStore, options: SchedulerOptions): Scheduler {
  const { log } = options;
  const allowed = new Set(options.allowedChats);
  const chats = new Map<string, ChatRuns>();
  const abort = new AbortController();

  function triggerOf(event: RobinEvent): Trigger | undefined {
    if (event.kind !== "message.created" || event.account === DERIVED_ACCOUNT || !allowed.has(event.chat)) {
      return undefined;
    }
    if (store.chatInfo(event.chat)?.type === "private")
      return { reason: "private", messageId: event.messageId };
    if (mentionsSelf(event, options.self)) return { reason: "mention", messageId: event.messageId };
    if (event.replyTo?.type === "message" && store.isSelfMessage(event.chat, event.replyTo.messageId)) {
      return { reason: "reply", messageId: event.messageId };
    }
    return undefined;
  }

  function start(chat: string, trigger: Trigger): void {
    const entry: ChatRuns = { running: Promise.resolve(), next: undefined };
    // Registered before the run starts: the run's first steps execute synchronously
    chats.set(chat, entry);
    entry.running = (async () => {
      let current = trigger;
      for (;;) {
        await options.run(chat, current, abort.signal);
        // Checked and cleared in one synchronous step, so no trigger slips in between
        if (!entry.next || abort.signal.aborted) {
          chats.delete(chat);
          return;
        }
        current = entry.next;
        entry.next = undefined;
      }
    })().catch((error: unknown) => {
      chats.delete(chat);
      options.onFatal(new Error(`Run in ${chat} failed`, { cause: error }));
    });
  }

  const unsubscribe = store.onCommit((events) => {
    if (abort.signal.aborted) return;
    for (const event of events) {
      const trigger = triggerOf(event);
      if (!trigger) continue;
      const entry = chats.get(event.chat);
      if (entry) entry.next = trigger;
      else start(event.chat, trigger);
    }
  });

  return {
    async stop() {
      unsubscribe();
      abort.abort(new Error("Robin is stopping"));
      const running = [...chats.values()].map((c) => c.running);
      const settled = await Promise.race([
        Promise.all(running).then(() => true),
        Bun.sleep(STOP_WAIT_MS).then(() => false),
      ]);
      if (!settled)
        log.warn("{count} runs did not stop within {ms} ms", { count: chats.size, ms: STOP_WAIT_MS });
    },
  };
}

function mentionsSelf(
  event: RobinEvent & { kind: "message.created" },
  self: SchedulerOptions["self"],
): boolean {
  const handle = self.username ? `@${self.username.toLowerCase()}` : undefined;
  return event.content.some(
    (part) =>
      part.type === "text" &&
      part.entities.some(
        (e) =>
          (e.type === "mention_user" && e.user === self.userKey) ||
          (e.type === "mention" &&
            handle !== undefined &&
            part.text.slice(e.offset, e.offset + e.length).toLowerCase() === handle),
      ),
  );
}
