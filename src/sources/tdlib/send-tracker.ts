import type * as td from "../../tdlib-api/td-api.ts";
import type { UpdateListener } from "./client.ts";
import { TdError } from "./errors.ts";

type Outcome = { ok: true; message: td.message } | { ok: false; error: Error };

interface Waiter {
  settle(outcome: Outcome): void;
}

export interface SendTracker {
  // Resolves with the final message once TDLib confirms the send of the temporary message tempId.
  // Safe to call after the confirmation already arrived: the hub delivers a whole worker batch
  // synchronously, so updateMessageSendSucceeded can land before the caller's await resumes
  wait(tempId: number, timeoutMs: number): Promise<td.message>;
  dispose(): void;
}

// Unclaimed outcomes kept for late callers; the oldest are dropped beyond this
const MAX_UNCLAIMED = 1_000;

// Matches updateMessageSendSucceeded / updateMessageSendFailed to the temporary id sendMessage returned
export function createSendTracker(onUpdate: (listener: UpdateListener) => () => void): SendTracker {
  const waiters = new Map<number, Waiter>();
  const unclaimed = new Map<number, Outcome>();

  const unsubscribe = onUpdate((update) => {
    let outcome: Outcome;
    if (update["@type"] === "updateMessageSendSucceeded") {
      outcome = { ok: true, message: update.message };
    } else if (update["@type"] === "updateMessageSendFailed") {
      outcome = { ok: false, error: new TdError(update.error.code, update.error.message, "sendMessage") };
    } else {
      return;
    }
    const tempId = update.old_message_id;

    const waiter = waiters.get(tempId);
    if (waiter) {
      waiters.delete(tempId);
      waiter.settle(outcome);
      return;
    }
    unclaimed.set(tempId, outcome);
    if (unclaimed.size > MAX_UNCLAIMED) {
      const oldest = unclaimed.keys().next().value;
      if (oldest !== undefined) unclaimed.delete(oldest);
    }
  });

  return {
    wait(tempId, timeoutMs) {
      const early = unclaimed.get(tempId);
      if (early) {
        unclaimed.delete(tempId);
        return early.ok ? Promise.resolve(early.message) : Promise.reject(early.error);
      }
      if (waiters.has(tempId)) return Promise.reject(new Error(`Already waiting for message ${tempId}`));
      return new Promise<td.message>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(tempId);
          reject(new Error(`No send confirmation for message ${tempId} in ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.set(tempId, {
          settle(outcome) {
            clearTimeout(timer);
            if (outcome.ok) resolve(outcome.message);
            else reject(outcome.error);
          },
        });
      });
    },
    dispose() {
      unsubscribe();
      unclaimed.clear();
      for (const [tempId, waiter] of waiters) {
        waiter.settle({ ok: false, error: new Error(`Stopped waiting for message ${tempId}`) });
      }
      waiters.clear();
    },
  };
}
