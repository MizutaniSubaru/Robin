// Send tracker: sendMessage returns a temporary message at once, and TDLib reports the real outcome
// later (updateMessageSendSucceeded / updateMessageSendFailed). This matches those updates to the
// temporary id, so a sender can await the final result

import type * as td from "../../tdlib-api/td-api.ts";
import type { UpdateListener } from "./account.ts";
import { TdError } from "./errors.ts";

type Outcome = { ok: true; message: td.message } | { ok: false; error: Error };

interface Waiter {
  settle(outcome: Outcome): void;
}

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SendTracker {
  // Resolves with the final message once TDLib confirms the send of the temporary message tempId in chatId.
  // Safe to call after the confirmation already arrived: the hub delivers a whole worker batch
  // synchronously, so updateMessageSendSucceeded can land before the caller's await resumes.
  // Without timeoutMs it waits until settled, aborted or disposed
  wait(chatId: number, tempId: number, options?: WaitOptions): Promise<td.message>;
  dispose(): void;
}

// Unclaimed outcomes kept for late callers; the oldest are dropped beyond this
const MAX_UNCLAIMED = 1_000;

// TDLib message ids, temporary ones included, are unique only within a chat
const sendKey = (chatId: number, tempId: number) => `${chatId}:${tempId}`;

export function createSendTracker(onUpdate: (listener: UpdateListener) => () => void): SendTracker {
  const waiters = new Map<string, Waiter>();
  const unclaimed = new Map<string, Outcome>();

  const unsubscribe = onUpdate((update) => {
    let outcome: Outcome;
    if (update["@type"] === "updateMessageSendSucceeded") {
      outcome = { ok: true, message: update.message };
    } else if (update["@type"] === "updateMessageSendFailed") {
      outcome = { ok: false, error: new TdError(update.error.code, update.error.message, "sendMessage") };
    } else {
      return;
    }
    const key = sendKey(update.message.chat_id, update.old_message_id);

    const waiter = waiters.get(key);
    if (waiter) {
      waiters.delete(key);
      waiter.settle(outcome);
      return;
    }
    unclaimed.set(key, outcome);
    if (unclaimed.size > MAX_UNCLAIMED) {
      const oldest = unclaimed.keys().next().value;
      if (oldest !== undefined) unclaimed.delete(oldest);
    }
  });

  return {
    wait(chatId, tempId, options) {
      const key = sendKey(chatId, tempId);
      const early = unclaimed.get(key);
      if (early) {
        unclaimed.delete(key);
        return early.ok ? Promise.resolve(early.message) : Promise.reject(early.error);
      }
      const signal = options?.signal;
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (waiters.has(key)) {
        return Promise.reject(new Error(`Already waiting for message ${tempId} in chat ${chatId}`));
      }
      const timeoutMs = options?.timeoutMs;
      return new Promise<td.message>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          waiters.delete(key);
          cleanup();
          reject(signal?.reason);
        };
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                waiters.delete(key);
                cleanup();
                reject(
                  new Error(
                    `No send confirmation for message ${tempId} in chat ${chatId} in ${timeoutMs} ms`,
                  ),
                );
              }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.set(key, {
          settle(outcome) {
            cleanup();
            if (outcome.ok) resolve(outcome.message);
            else reject(outcome.error);
          },
        });
      });
    },
    dispose() {
      unsubscribe();
      unclaimed.clear();
      for (const [key, waiter] of waiters) {
        waiter.settle({ ok: false, error: new Error(`Stopped waiting for message ${key}`) });
      }
      waiters.clear();
    },
  };
}
