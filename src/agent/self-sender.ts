// Self-sender (Pipeline B): how Robin sends a message. It records the message in the event log
// first, then hands it to the platform, and records every later change of its state

import type { TextEntity } from "../core/events/index.ts";
import type { EventStore } from "../core/store/index.ts";
import type { Logger } from "../log/index.ts";

// ok: false when the platform refused the message: final. Other failures are thrown: unknown outcome
export type SendOutcome = { ok: true; messageId: string; date: number } | { ok: false; error: string };

export interface FormattedText {
  text: string;
  entities: readonly TextEntity[];
}

// The platform half of sending; the source implements it
export interface Outbound {
  readonly maxTextLength: number;
  send(
    chat: string,
    text: FormattedText,
    replyTo: string | null,
    onAccepted: (tempId: string) => void,
    signal?: AbortSignal,
  ): Promise<SendOutcome>;
  reconcile(chat: string, tempId: string): Promise<SendOutcome>;
}

export interface SelfSender {
  send(
    chat: string,
    runId: string,
    text: FormattedText,
    replyTo: string | null,
    signal?: AbortSignal,
  ): Promise<SendOutcome>;
  // At startup, before any run: settles what a previous process left sending
  recover(): void;
}

// A crash at any point leaves at worst a pending message, which
// recover() turns into "maybe sent"; never a sent message the log does not know about
export function createSelfSender(
  store: EventStore,
  outbound: Outbound,
  account: string,
  log: Logger,
): SelfSender {
  function result(
    chat: string,
    target: string,
    outcome: SendOutcome | "unknown" | { accepted: string },
    serverDate: number | null = null,
  ): void {
    const base = { kind: "self.send_result" as const, target, messageId: null, tempId: null, error: null };
    if (outcome === "unknown") store.appendSelf(chat, account, { ...base, result: "unknown" });
    else if ("accepted" in outcome)
      store.appendSelf(chat, account, { ...base, result: "accepted", tempId: outcome.accepted });
    else if (outcome.ok) {
      store.appendSelf(chat, account, { ...base, result: "sent", messageId: outcome.messageId }, serverDate);
    } else store.appendSelf(chat, account, { ...base, result: "failed", error: outcome.error });
  }

  return {
    async send(chat, runId, text, replyTo, signal) {
      const message = store.appendSelf(chat, account, {
        kind: "self.message",
        runId,
        replyTo,
        content: [{ type: "text", text: text.text, entities: [...text.entities] }],
      });
      if (!message) throw new Error("A self.message was deduplicated; it has no dedup key");
      const outcome = await outbound.send(
        chat,
        text,
        replyTo,
        (tempId) => result(chat, message.eventId, { accepted: tempId }),
        signal,
      );
      result(chat, message.eventId, outcome, outcome.ok ? outcome.date : null);
      return outcome;
    },
    recover() {
      for (const pending of store.pendingSends()) {
        result(pending.chat, pending.eventId, "unknown");
        log.warn("Message {eventId} in {chat} was still sending at the last shutdown", { ...pending });
        if (pending.tempId === null) continue;
        // TDLib finishes sends it accepted before the restart and reports them under the old temporary id
        outbound.reconcile(pending.chat, pending.tempId).then(
          (outcome) => result(pending.chat, pending.eventId, outcome, outcome.ok ? outcome.date : null),
          (error: unknown) =>
            log.warn("Could not settle message {eventId}", { eventId: pending.eventId, error }),
        );
      }
    },
  };
}
