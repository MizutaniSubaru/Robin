import type { RobinEvent } from "../core/events/index.ts";
import { DERIVED_ACCOUNT, type EventStore } from "../core/store/index.ts";
import type { Logger } from "../log/index.ts";
import type { Trigger } from "./run.ts";

export interface SchedulerOptions {
  allowedChats: readonly string[];
  // How the bot is addressed: @username in text, or a mention of its user key
  self: { username: string | undefined; userKey: string };
  // A private chat runs once it has been quiet this long, so a burst of messages gets one answer
  privateDebounceMs: number;
  // Resolves to the ts up to which the model read the chat; triggers up to there need no run
  run(chat: string, trigger: Trigger, signal: AbortSignal): Promise<number>;
  // A run failed with something other than a model error: a bug or a broken database
  onFatal(error: Error): void;
  log: Logger;
}

export interface Scheduler {
  // Aborts the runs and waits for every one of them to end, so none touches the database after it.
  // Whatever a run waits on ends with the abort or on its own timeout
  stop(): Promise<void>;
}

interface ChatRuns {
  running: Promise<void>;
  // Triggers that came in during the run: one more run afterwards covers them all
  next: Trigger | undefined;
}

// Starts runs: in private chats once messages stop coming for privateDebounceMs, in groups as soon as
// Robin is mentioned or replied to. Robin's own events never trigger anything. Runs of one chat never
// overlap; triggers arriving meanwhile fold into a single follow-up run, unless the run already showed
// them to the model
export function createScheduler(store: EventStore, options: SchedulerOptions): Scheduler {
  const { log } = options;
  const allowed = new Set(options.allowedChats);
  const chats = new Map<string, ChatRuns>();
  // Private chats waiting out their debounce; each new message restarts the wait
  const quieting = new Map<string, ReturnType<typeof setTimeout>>();
  // Per chat, the ts up to which a run has shown the chat to the model
  const read = new Map<string, number>();
  const abort = new AbortController();

  const unread = (chat: string, trigger: Trigger) => trigger.ts > (read.get(chat) ?? 0);

  function triggerOf(event: RobinEvent): Trigger | undefined {
    if (event.kind !== "message.created" || event.account === DERIVED_ACCOUNT || !allowed.has(event.chat)) {
      return undefined;
    }
    const { messageId, ts } = event;
    if (store.chatInfo(event.chat)?.type === "private") return { reason: "private", messageId, ts };
    if (mentionsSelf(event, options.self)) return { reason: "mention", messageId, ts };
    if (event.replyTo?.type === "message" && store.isSelfMessage(event.chat, event.replyTo.messageId)) {
      return { reason: "reply", messageId, ts };
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
        const readTs = await options.run(chat, current, abort.signal);
        read.set(chat, Math.max(read.get(chat) ?? 0, readTs));
        // Checked and cleared in one synchronous step, so no trigger slips in between
        if (!entry.next || !unread(chat, entry.next) || abort.signal.aborted) {
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

  function request(chat: string, trigger: Trigger): void {
    if (!unread(chat, trigger)) return;
    const entry = chats.get(chat);
    if (entry) entry.next = trigger;
    else start(chat, trigger);
  }

  function debounce(chat: string, trigger: Trigger): void {
    clearTimeout(quieting.get(chat));
    quieting.set(
      chat,
      setTimeout(() => {
        quieting.delete(chat);
        request(chat, trigger);
      }, options.privateDebounceMs),
    );
  }

  const unsubscribe = store.onCommit((events) => {
    if (abort.signal.aborted) return;
    for (const event of events) {
      const trigger = triggerOf(event);
      if (!trigger) continue;
      if (trigger.reason === "private") debounce(event.chat, trigger);
      else request(event.chat, trigger);
    }
  });

  return {
    async stop() {
      unsubscribe();
      abort.abort(new Error("Robin is stopping"));
      for (const timer of quieting.values()) clearTimeout(timer);
      quieting.clear();
      if (chats.size > 0) log.info("Waiting for {count} runs to stop", { count: chats.size });
      await Promise.all([...chats.values()].map((c) => c.running));
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
