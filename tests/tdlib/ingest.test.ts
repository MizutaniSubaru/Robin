import { describe, expect, test } from "bun:test";

import type { InboundItem } from "../../src/core/store/index.ts";
import { getLogger } from "../../src/log/index.ts";
import { createIngest, createTelegramAdapter, type td } from "../../src/sources/tdlib/index.ts";
import { createUpdateFilter } from "../../src/sources/tdlib/update-filter.ts";
import { update } from "../fixtures/td.ts";

const GROUP = -1003754645572;
const T = 1_793_954_128_060_713;

const message = (userId: number, serverId = 1) =>
  update({
    "@type": "updateNewMessage",
    message: {
      "@type": "message",
      id: serverId * 2 ** 20,
      chat_id: GROUP,
      sender_id: { "@type": "messageSenderUser", user_id: userId },
      is_outgoing: false,
      date: 1793954127,
      content: { "@type": "messageText", text: { "@type": "formattedText", text: "hi", entities: [] } },
    },
  });

describe("createIngest", () => {
  // Regression: an update the adapter threw on was fatal, so one odd update stopped the bot
  test("stores every kept update, and skips one the adapter fails on", () => {
    const stored: td.Update["@type"][] = [];
    const accepted: InboundItem[] = [];
    const real = createTelegramAdapter({ botUserId: 900 });
    const listener = createIngest("user", {
      filter: { keep: (u) => u["@type"] !== "updateOption" },
      rawUpdates: { push: (_account, u) => stored.push(u["@type"]) },
      adapter: {
        adapt: (account, u, receivedAt) => {
          if (u["@type"] === "updateNewMessage") throw new Error("adapter bug");
          return real.adapt(account, u, receivedAt);
        },
      },
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
    listener(update({ "@type": "updateOption", name: "version", value: { "@type": "optionValueEmpty" } }), T);
    listener(message(7), T + 1);
    listener(newChat, T + 2);
    expect(stored).toEqual(["updateNewMessage", "updateNewChat"]);
    expect(accepted).toMatchObject([{ type: "chat", chat: `tg:${GROUP}`, title: "Lab" }]);
  });

  // Regression: the filter threw outside the isolation boundary, so its failure was fatal
  test("keeps and adapts an update the filter fails on", () => {
    const stored: td.Update["@type"][] = [];
    const adapted: td.Update["@type"][] = [];
    const listener = createIngest("user", {
      filter: {
        keep: () => {
          throw new Error("filter bug");
        },
      },
      rawUpdates: { push: (_account, u) => stored.push(u["@type"]) },
      adapter: {
        adapt: (_account, u) => {
          adapted.push(u["@type"]);
          return [];
        },
      },
      inbound: { accept: () => {} },
      log: getLogger("test"),
    });
    expect(() => listener(message(7), T)).not.toThrow();
    expect(stored).toEqual(["updateNewMessage"]);
    expect(adapted).toEqual(["updateNewMessage"]);
  });

  // Regression: a message for a chat or from a user TDLib had not introduced yet threw in the filter
  // (fatal) or the adapter (message lost)
  test("a message before its chat and sender are introduced neither throws nor stops later ones", () => {
    const accepted: InboundItem[] = [];
    const listener = createIngest("user", {
      filter: createUpdateFilter("user"),
      rawUpdates: { push: () => {} },
      adapter: createTelegramAdapter({ botUserId: 900 }),
      inbound: { accept: (item) => accepted.push(item) },
      log: getLogger("test"),
    });
    expect(() => listener(message(7), T)).not.toThrow();
    listener(
      update({
        "@type": "updateNewChat",
        chat: {
          "@type": "chat",
          id: GROUP,
          type: { "@type": "chatTypeSupergroup", supergroup_id: 3754645572, is_channel: false },
          title: "Lab",
        },
      }),
      T + 1,
    );
    listener(message(7, 2), T + 2);
    expect(accepted).toMatchObject([
      { type: "chat", chat: `tg:${GROUP}` },
      { type: "event", body: { kind: "message.created", messageId: "2", senderName: "" } },
    ]);
  });

  // Regression: the bot's filter dropped channel and group updateNewChat, so a forward from a channel
  // into a private chat failed in the adapter, live and on every replay of raw_updates
  test("the bot names a channel a private message was forwarded from", () => {
    const stored: td.Update[] = [];
    const replay = () => {
      const adapter = createTelegramAdapter({ botUserId: 900 });
      return stored.flatMap((u, i) => adapter.adapt("bot", u, T + i));
    };
    const listener = createIngest("bot", {
      filter: createUpdateFilter("bot"),
      rawUpdates: { push: (_account, u) => stored.push(u) },
      adapter: createTelegramAdapter({ botUserId: 900 }),
      inbound: { accept: () => {} },
      log: getLogger("test"),
    });
    const newChat = (id: number, type: td.ChatType, title: string) =>
      update({ "@type": "updateNewChat", chat: { "@type": "chat", id, type, title } });
    listener(
      update({ "@type": "updateUser", user: { "@type": "user", id: 7, first_name: "Alice", last_name: "" } }),
      T,
    );
    listener(
      newChat(-1009, { "@type": "chatTypeSupergroup", supergroup_id: 9, is_channel: true }, "News"),
      T + 1,
    );
    listener(newChat(7, { "@type": "chatTypePrivate", user_id: 7 }, "Alice"), T + 2);
    listener(
      update({
        "@type": "updateNewMessage",
        message: {
          "@type": "message",
          id: 1 << 20,
          chat_id: 7,
          sender_id: { "@type": "messageSenderUser", user_id: 7 },
          is_outgoing: false,
          date: 1793954127,
          forward_info: {
            "@type": "messageForwardInfo",
            origin: {
              "@type": "messageOriginChannel",
              chat_id: -1009,
              message_id: 1 << 20,
              author_signature: "",
            },
          },
          content: { "@type": "messageText", text: { "@type": "formattedText", text: "hi", entities: [] } },
        },
      }),
      T + 3,
    );
    expect(replay().filter((item) => item.type === "event")).toMatchObject([
      { chat: "tg:bot:7", body: { kind: "message.created", forwardedFrom: "News" } },
    ]);
  });
});
