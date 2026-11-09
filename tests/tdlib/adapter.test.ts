import { describe, expect, test } from "bun:test";

import { createTelegramAdapter } from "../../src/sources/tdlib/adapter.ts";
import type { td } from "../../src/sources/tdlib/index.ts";
import { update } from "../fixtures/td.ts";

const BOT = 900;
const GROUP = -1003754645572;
const T = 1_793_954_128_060_713;

const supergroup: td.ChatType = {
  "@type": "chatTypeSupergroup",
  supergroup_id: 3754645572,
  is_channel: false,
};
const channel: td.ChatType = { "@type": "chatTypeSupergroup", supergroup_id: 77, is_channel: true };
const basicGroup: td.ChatType = { "@type": "chatTypeBasicGroup", basic_group_id: 3 };
const privateWith = (userId: number): td.ChatType => ({ "@type": "chatTypePrivate", user_id: userId });

const newChat = (id: number, type: td.ChatType, title = `chat ${id}`) =>
  update({ "@type": "updateNewChat", chat: { "@type": "chat", id, type, title } });
const user = (id: number, first: string, last = "") =>
  update({ "@type": "updateUser", user: { "@type": "user", id, first_name: first, last_name: last } });
const formatted = (text: string, entities: td.textEntity[] = []): td.formattedText => ({
  "@type": "formattedText",
  text,
  entities,
});

function message(fields: Record<string, unknown> & { chat_id: number; id: number }) {
  return update({
    "@type": "updateNewMessage",
    message: {
      "@type": "message",
      sender_id: { "@type": "messageSenderUser", user_id: 7 },
      is_outgoing: false,
      date: 1793954127,
      content: { "@type": "messageText", text: formatted("你好robin") },
      ...fields,
    },
  });
}

function adapter() {
  const a = createTelegramAdapter({ botUserId: BOT });
  a.adapt("user", user(7, "Alice", "Liddell"), T);
  a.adapt("user", user(8, "Bob"), T);
  a.adapt("user", user(BOT, "Robin"), T);
  return a;
}

describe("createTelegramAdapter", () => {
  test("a supergroup message through the user account", () => {
    const a = adapter();
    expect(a.adapt("user", newChat(GROUP, supergroup, "未来道具研究所"), T)).toEqual([
      {
        type: "chat",
        chat: `tg:${GROUP}`,
        chatType: "supergroup",
        title: "未来道具研究所",
        inboundAccount: "user",
      },
    ]);
    expect(a.adapt("user", message({ chat_id: GROUP, id: 538968064 }), T + 1)).toEqual([
      {
        type: "event",
        chat: `tg:${GROUP}`,
        account: "user",
        receivedAt: T + 1,
        serverDate: 1793954127,
        users: { "tg:user:7": "Alice Liddell" },
        body: {
          kind: "message.created",
          // Server id, not TDLib's id
          messageId: "514",
          sender: "tg:user:7",
          senderName: "Alice Liddell",
          replyTo: null,
          forwardedFrom: null,
          content: [{ type: "text", text: "你好robin", entities: [] }],
        },
      },
    ]);
  });

  test("leaves out Robin's own messages, the user account's, and chats it does not serve", () => {
    const a = adapter();
    a.adapt("user", newChat(GROUP, supergroup), T);
    a.adapt("user", newChat(-3, basicGroup), T);
    a.adapt("user", newChat(7, privateWith(7)), T);
    a.adapt("bot", newChat(GROUP, supergroup), T);
    const fromBot = { "@type": "messageSenderUser", user_id: BOT };
    expect(a.adapt("user", message({ chat_id: GROUP, id: 1 << 20, sender_id: fromBot }), T)).toEqual([]);
    expect(a.adapt("user", message({ chat_id: GROUP, id: 2 << 20, is_outgoing: true }), T)).toEqual([]);
    expect(a.adapt("user", message({ chat_id: -3, id: 3 << 20 }), T)).toEqual([]);
    expect(a.adapt("user", message({ chat_id: 7, id: 4 << 20 }), T)).toEqual([]);
    // The bot sees groups too (privacy mode off) but the user account is their source
    expect(a.adapt("bot", message({ chat_id: GROUP, id: 5 << 20 }), T)).toEqual([]);
    // Not yet sent: no server id
    expect(a.adapt("user", message({ chat_id: GROUP, id: (6 << 20) + 1 }), T)).toEqual([]);
  });

  test("a private chat through the bot", () => {
    const a = adapter();
    a.adapt("bot", user(7, "Alice"), T);
    expect(a.adapt("bot", newChat(7, privateWith(7), "Alice"), T)).toMatchObject([
      { type: "chat", chat: "tg:bot:7", chatType: "private", inboundAccount: "bot" },
    ]);
    expect(a.adapt("bot", message({ chat_id: 7, id: 9 << 20 }), T)).toMatchObject([
      { chat: "tg:bot:7", account: "bot", body: { messageId: "9" } },
    ]);
    expect(a.adapt("bot", message({ chat_id: 7, id: 10 << 20, is_outgoing: true }), T)).toEqual([]);
  });

  test("replies: a picked quote, a whole message, another chat", () => {
    const a = adapter();
    a.adapt("user", newChat(GROUP, supergroup), T);
    const reply = (fields: Record<string, unknown>) =>
      a.adapt(
        "user",
        message({ chat_id: GROUP, id: 20 << 20, reply_to: { "@type": "messageReplyToMessage", ...fields } }),
        T,
      )[0];
    const quote = (text: string, isManual: boolean) => ({
      "@type": "textQuote",
      text: formatted(text),
      is_manual: isManual,
    });
    expect(reply({ chat_id: GROUP, message_id: 3 << 20, quote: quote("part", true) })).toMatchObject({
      body: { replyTo: { type: "message", messageId: "3", quote: "part" } },
    });
    expect(reply({ chat_id: GROUP, message_id: 3 << 20, quote: quote("auto", false) })).toMatchObject({
      body: { replyTo: { type: "message", messageId: "3", quote: null } },
    });
    expect(reply({ chat_id: -55, message_id: 3 << 20, quote: quote("elsewhere", false) })).toMatchObject({
      body: { replyTo: { type: "external", quote: "elsewhere" } },
    });
  });

  test("content: captions, stickers, unsupported media, mentions; service messages are skipped", () => {
    const a = adapter();
    a.adapt("user", newChat(GROUP, supergroup), T);
    const content = (value: Record<string, unknown>) =>
      a.adapt("user", message({ chat_id: GROUP, id: 30 << 20, content: value }), T)[0];
    expect(content({ "@type": "messagePhoto", caption: formatted("look") })).toMatchObject({
      body: {
        content: [
          { type: "unsupported", kind: "photo" },
          { type: "text", text: "look" },
        ],
      },
    });
    expect(content({ "@type": "messageSticker", sticker: { emoji: "😂" } })).toMatchObject({
      body: { content: [{ type: "sticker", emoji: "😂" }] },
    });
    const mention: td.textEntity = {
      "@type": "textEntity",
      offset: 3,
      length: 3,
      type: { "@type": "textEntityTypeMentionName", user_id: 8 },
    };
    expect(content({ "@type": "messageText", text: formatted("hi Bob", [mention]) })).toMatchObject({
      users: { "tg:user:7": "Alice Liddell", "tg:user:8": "Bob" },
      body: { content: [{ entities: [{ type: "mention_user", user: "tg:user:8", offset: 3, length: 3 }] }] },
    });
    expect(content({ "@type": "messageChatAddMembers", member_user_ids: [8] })).toBeUndefined();
  });

  test("names channel senders and forward origins", () => {
    const a = adapter();
    a.adapt("user", newChat(GROUP, supergroup), T);
    a.adapt("user", newChat(-1009, channel, "News"), T);
    expect(
      a.adapt(
        "user",
        message({
          chat_id: GROUP,
          id: 40 << 20,
          sender_id: { "@type": "messageSenderChat", chat_id: -1009 },
          forward_info: {
            "@type": "messageForwardInfo",
            origin: { "@type": "messageOriginHiddenUser", sender_name: "Ghost" },
          },
        }),
        T,
      )[0],
    ).toMatchObject({ body: { sender: "tg:chat:-1009", senderName: "News", forwardedFrom: "Ghost" } });
  });

  test("an edit is the new content dated by the edit that follows it", () => {
    const a = adapter();
    a.adapt("user", newChat(GROUP, supergroup), T);
    const content = update({
      "@type": "updateMessageContent",
      chat_id: GROUP,
      message_id: 538968064,
      new_content: { "@type": "messageText", text: formatted("你好robin 你是谁") },
    });
    const editedAt = update({
      "@type": "updateMessageEdited",
      chat_id: GROUP,
      message_id: 538968064,
      edit_date: 1793954153,
    });
    expect(a.adapt("user", content, T)).toEqual([]);
    expect(a.adapt("user", editedAt, T + 1)).toMatchObject([
      {
        serverDate: 1793954153,
        body: { kind: "message.edited", messageId: "514", content: [{ text: "你好robin 你是谁" }] },
      },
    ]);
    // Only the reply markup changed
    expect(a.adapt("user", editedAt, T + 2)).toEqual([]);
  });

  // Regression: a link preview arriving made TDLib send new content with edit_date 0, which became
  // an edit without a date and stopped the process when the store refused it
  test("a content refresh without an edit date is not an edit", () => {
    const a = adapter();
    a.adapt("user", newChat(GROUP, supergroup), T);
    const refreshed = update({
      "@type": "updateMessageContent",
      chat_id: GROUP,
      message_id: 538968064,
      new_content: { "@type": "messageText", text: formatted("see https://example.com") },
    });
    const undated = update({
      "@type": "updateMessageEdited",
      chat_id: GROUP,
      message_id: 538968064,
      edit_date: 0,
    });
    expect(a.adapt("user", refreshed, T)).toEqual([]);
    expect(a.adapt("user", undated, T + 1)).toEqual([]);
    // The refreshed content was used up; a later markup-only edit finds nothing pending
    expect(a.adapt("user", { ...undated, edit_date: 1793954153 }, T + 2)).toEqual([]);
  });

  test("content that never gets its updateMessageEdited is eventually dropped", () => {
    const a = adapter();
    a.adapt("user", newChat(GROUP, supergroup), T);
    const content = (n: number) =>
      update({
        "@type": "updateMessageContent",
        chat_id: GROUP,
        message_id: n * 1048576,
        new_content: { "@type": "messageText", text: formatted(`v${n}`) },
      });
    const edited = (n: number) =>
      update({
        "@type": "updateMessageEdited",
        chat_id: GROUP,
        message_id: n * 1048576,
        edit_date: 1793954153,
      });
    for (let n = 1; n <= 1001; n++) a.adapt("user", content(n), T);
    expect(a.adapt("user", edited(1), T + 1)).toEqual([]);
    expect(a.adapt("user", edited(1001), T + 1)).toMatchObject([
      { body: { kind: "message.edited", messageId: "1001", content: [{ text: "v1001" }] } },
    ]);
  });

  test("only permanent deletions", () => {
    const a = adapter();
    a.adapt("user", newChat(GROUP, supergroup), T);
    const deletion = (is_permanent: boolean, from_cache: boolean) =>
      update({
        "@type": "updateDeleteMessages",
        chat_id: GROUP,
        message_ids: [538968064, 1 << 20],
        is_permanent,
        from_cache,
      });
    expect(a.adapt("user", deletion(true, false), T).map((i) => (i.type === "event" ? i.body : i))).toEqual([
      { kind: "message.deleted", messageId: "514" },
      { kind: "message.deleted", messageId: "1" },
    ]);
    expect(a.adapt("user", deletion(false, true), T)).toEqual([]);
  });

  test("a changed name is a profile update; the first sight of a user is not", () => {
    const a = createTelegramAdapter({ botUserId: BOT });
    expect(a.adapt("user", user(7, "Alice"), T)).toEqual([]);
    expect(a.adapt("bot", user(7, "Alice"), T)).toEqual([]);
    expect(a.adapt("user", user(7, "Ally"), T + 1)).toEqual([
      { type: "profile", user: "tg:user:7", name: "Ally", receivedAt: T + 1 },
    ]);
  });

  test("fails loudly on a user or chat TDLib never introduced", () => {
    const a = createTelegramAdapter({ botUserId: BOT });
    expect(() => a.adapt("user", message({ chat_id: GROUP, id: 1 << 20 }), T)).toThrow(/updateNewChat/);
    a.adapt("user", newChat(GROUP, supergroup), T);
    expect(() => a.adapt("user", message({ chat_id: GROUP, id: 1 << 20 }), T)).toThrow(/updateUser/);
  });
});
