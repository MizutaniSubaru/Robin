import { describe, expect, test } from "bun:test";

import type { InboundItem } from "../../src/core/store/index.ts";
import { getLogger } from "../../src/log/index.ts";
import { createIngest, createTelegramAdapter, type td } from "../../src/sources/tdlib/index.ts";
import { update } from "../fixtures/td.ts";

const GROUP = -1003754645572;
const T = 1_793_954_128_060_713;

describe("createIngest", () => {
  // Regression: an update the adapter threw on was fatal, so one odd update stopped the bot
  test("stores every kept update, and skips one the adapter fails on", () => {
    const stored: td.Update["@type"][] = [];
    const accepted: InboundItem[] = [];
    const listener = createIngest("user", {
      filter: { keep: (u) => u["@type"] !== "updateOption" },
      rawUpdates: { push: (_account, u) => stored.push(u["@type"]) },
      adapter: createTelegramAdapter({ botUserId: 900 }),
      inbound: { accept: (item) => accepted.push(item) },
      log: getLogger("test"),
    });
    const newChat = update({
      "@type": "updateNewChat",
      chat: {
        "@type": "chat",
        id: GROUP,
        type: { "@type": "chatTypeSupergroup", supergroup_id: 3754645572, is_channel: false },
        title: "Lab",
      },
    });
    // A message from a user TDLib never introduced: the adapter throws
    const orphan = update({
      "@type": "updateNewMessage",
      message: {
        "@type": "message",
        id: 1 << 20,
        chat_id: GROUP,
        sender_id: { "@type": "messageSenderUser", user_id: 7 },
        is_outgoing: false,
        date: 1793954127,
        content: { "@type": "messageText", text: { "@type": "formattedText", text: "hi", entities: [] } },
      },
    });
    listener(update({ "@type": "updateOption", name: "version", value: { "@type": "optionValueEmpty" } }), T);
    listener(orphan, T + 1);
    listener(newChat, T + 2);
    expect(stored).toEqual(["updateNewMessage", "updateNewChat"]);
    expect(accepted).toMatchObject([{ type: "chat", chat: `tg:${GROUP}`, title: "Lab" }]);
  });
});
