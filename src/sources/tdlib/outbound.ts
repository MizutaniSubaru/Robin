// Sender: sends Robin's messages to Telegram through the bot account and waits until Telegram
// confirms or rejects them. app.ts gives it to the agent as its Outbound

import type { TextEntity } from "../../core/events/index.ts";
import type * as td from "../../tdlib-api/td-api.ts";
import type { TdAccount } from "./account.ts";
import { toTdEntities } from "./entities.ts";
import { TdError } from "./errors.ts";
import { chatIdOf } from "./keys.ts";
import { toServerMessageId, toTdMessageId } from "./message-id.ts";
import type { SendTracker, WaitOptions } from "./send-tracker.ts";

// ok: false when Telegram said no (bad request, no rights, flood wait): final, the message failed.
// Any other error is thrown: Robin does not know what happened, and the message stays pending
export type SendOutcome =
  | {
      ok: true;
      messageId: string;
      // Server time, seconds
      date: number;
    }
  | { ok: false; error: string };

export interface TelegramSender {
  // Longest text Telegram takes in one message, in UTF-16 units
  readonly maxTextLength: number;
  // Resolves once Telegram confirmed the message. onAccepted fires when TDLib took it and handed
  // out the temporary id that a later restart can match
  send(
    chat: string,
    text: { text: string; entities: readonly TextEntity[] },
    replyTo: string | null,
    onAccepted: (tempId: string) => void,
    signal?: AbortSignal,
  ): Promise<SendOutcome>;
  // After a restart: the outcome of a message TDLib accepted before it, if TDLib finishes sending it
  reconcile(chat: string, tempId: string): Promise<SendOutcome>;
}

export interface TelegramSenderOptions {
  // How long reconcile() waits for a pre-restart tempId before giving up so stale ids do not leak
  reconcileTimeoutMs?: number;
}

const DEFAULT_RECONCILE_TIMEOUT_MS = 120_000;

export function createTelegramSender(
  bot: TdAccount,
  tracker: SendTracker,
  options?: TelegramSenderOptions,
): TelegramSender {
  const reconcileTimeoutMs = options?.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;

  async function confirmed(chatId: number, tempId: number, waitOptions?: WaitOptions): Promise<SendOutcome> {
    let final: td.message;
    try {
      final = await tracker.wait(chatId, tempId, waitOptions);
    } catch (error) {
      return rejected(error);
    }
    const messageId = toServerMessageId(final.id);
    if (messageId === undefined) throw new Error(`Sent message ${final.id} has no server id`);
    return { ok: true, messageId: String(messageId), date: final.date };
  }

  return {
    maxTextLength: 4096,
    async send(chat, text, replyTo, onAccepted, signal) {
      const chatId = chatIdOf(chat);
      let pending: td.message;
      try {
        // The bot learns of a chat only from its updates, so a quiet group is one TDLib does not know
        // and sendMessage fails with "Chat not found". getChat loads it from the server for a bot. It
        // runs before every send, not once per chat: a known chat answers from memory, and a cache
        // here would outlive the client after TDLib restarts it
        await bot.invoke({ "@type": "getChat", chat_id: chatId });
        pending = await bot.invoke({
          "@type": "sendMessage",
          chat_id: chatId,
          ...(replyTo === null
            ? {}
            : {
                reply_to: {
                  "@type": "inputMessageReplyToMessage",
                  message_id: toTdMessageId(Number(replyTo)),
                  checklist_task_id: 0,
                  poll_option_id: "",
                },
              }),
          input_message_content: {
            "@type": "inputMessageText",
            text: { "@type": "formattedText", text: text.text, entities: toTdEntities(text.entities) },
            clear_draft: false,
          },
        });
      } catch (error) {
        return rejected(error);
      }
      onAccepted(String(pending.id));
      return confirmed(chatId, pending.id, signal ? { signal } : undefined);
    },
    reconcile(chat, tempId) {
      return confirmed(chatIdOf(chat), Number(tempId), { timeoutMs: reconcileTimeoutMs });
    },
  };
}

function rejected(error: unknown): SendOutcome {
  if (error instanceof TdError) return { ok: false, error: `${error.code}: ${error.tdMessage}` };
  throw error;
}
