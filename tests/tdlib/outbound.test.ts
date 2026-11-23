import { describe, expect, test } from "bun:test";

import type { TdAccount } from "../../src/sources/tdlib/account.ts";
import { TdError } from "../../src/sources/tdlib/errors.ts";
import { createSendTracker, createTelegramSender, type td } from "../../src/sources/tdlib/index.ts";
import type { SendTracker } from "../../src/sources/tdlib/send-tracker.ts";

const GROUP = -1003754645572;
const TEMP_ID = 5;

// A bot whose TDLib knows only the chats in `known` until getChat loads them, as for a real bot
function fakeBot(known: Set<number>, loadable: Set<number>) {
  const requests: string[] = [];
  const handle = (request: td.Request): unknown => {
    requests.push(request["@type"]);
    switch (request["@type"]) {
      case "getChat":
        if (!loadable.has(request.chat_id)) throw new TdError(400, "Chat not found", "getChat");
        known.add(request.chat_id);
        return { "@type": "chat", id: request.chat_id };
      case "sendMessage":
        if (!known.has(request.chat_id)) throw new TdError(400, "Chat not found", "sendMessage");
        return { "@type": "message", id: TEMP_ID, chat_id: request.chat_id };
      default:
        throw new Error(`Unexpected ${request["@type"]}`);
    }
  };
  const bot: Pick<TdAccount, "invoke"> = {
    invoke: async <R extends td.Request>(request: R) => handle(request) as td.ResultOf<R>,
  };
  return { bot: bot as TdAccount, requests };
}

const tracker: SendTracker = {
  wait: async (chatId, tempId) => {
    expect(tempId).toBe(TEMP_ID);
    return { "@type": "message", id: 42 << 20, chat_id: chatId, date: 1793954127 } as td.message;
  },
  dispose: () => {},
};

const text = { text: "hi", entities: [] };

describe("createTelegramSender", () => {
  // Regression: the bot had no updateNewChat for a group that stayed quiet since it joined, so
  // sendMessage failed with "Chat not found"
  test("loads a chat the bot has not seen before sending to it", async () => {
    const { bot, requests } = fakeBot(new Set(), new Set([GROUP]));
    const accepted: string[] = [];
    const outcome = await createTelegramSender(bot, tracker).send(`tg:${GROUP}`, text, null, (id) =>
      accepted.push(id),
    );
    expect(outcome).toEqual({ ok: true, messageId: "42", date: 1793954127 });
    expect(accepted).toEqual([String(TEMP_ID)]);
    expect(requests).toEqual(["getChat", "sendMessage"]);
  });

  test("a chat Telegram will not give the bot fails the send", async () => {
    const { bot, requests } = fakeBot(new Set(), new Set());
    const outcome = await createTelegramSender(bot, tracker).send(`tg:${GROUP}`, text, null, () => {
      throw new Error("Not accepted");
    });
    expect(outcome).toEqual({ ok: false, error: "400: Chat not found" });
    expect(requests).toEqual(["getChat"]);
  });

  test("send passes AbortSignal to the tracker and rethrows on abort", async () => {
    const { bot } = fakeBot(new Set([GROUP]), new Set([GROUP]));
    const liveTracker = createSendTracker(() => () => {});
    const controller = new AbortController();
    const pending = createTelegramSender(bot, liveTracker).send(
      `tg:${GROUP}`,
      text,
      null,
      () => controller.abort(new Error("stopping")),
      controller.signal,
    );
    await expect(pending).rejects.toThrow("stopping");
  });

  test("reconcile gives up after its timeout so stale temp ids do not linger", async () => {
    const { bot } = fakeBot(new Set([GROUP]), new Set([GROUP]));
    const liveTracker = createSendTracker(() => () => {});
    const sender = createTelegramSender(bot, liveTracker, { reconcileTimeoutMs: 20 });
    await expect(sender.reconcile(`tg:${GROUP}`, String(TEMP_ID))).rejects.toThrow(/No send confirmation/);
  });
});
