import { describe, expect, test } from "bun:test";

import type { td } from "../../src/sources/tdlib/index.ts";
import { createUpdateFilter } from "../../src/sources/tdlib/update-filter.ts";
import { update } from "../fixtures/td.ts";

const newChat = (id: number, type: td.ChatType) =>
  update({ "@type": "updateNewChat", chat: { "@type": "chat", id, type, title: `chat ${id}` } });
const newMessage = (chatId: number) =>
  update({ "@type": "updateNewMessage", message: { "@type": "message", id: 1 << 20, chat_id: chatId } });
const user = (id: number, firstName: string) =>
  update({
    "@type": "updateUser",
    user: {
      "@type": "user",
      id,
      first_name: firstName,
      last_name: "",
      usernames: { "@type": "usernames", active_usernames: ["a"] },
    },
  });
const supergroup = (isChannel: boolean): td.ChatType => ({
  "@type": "chatTypeSupergroup",
  supergroup_id: 1,
  is_channel: isChannel,
});
const basicGroup: td.ChatType = { "@type": "chatTypeBasicGroup", basic_group_id: 3 };
const privateChat: td.ChatType = { "@type": "chatTypePrivate", user_id: 4 };
const secretChat: td.ChatType = { "@type": "chatTypeSecret", secret_chat_id: 5, user_id: 4 };

describe("createUpdateFilter", () => {
  test("drops noise updates", () => {
    const filter = createUpdateFilter("user");
    const types: td.Update["@type"][] = [
      "updateChatAction",
      "updateUserStatus",
      "updateChatReadInbox",
      "updateChatLastMessage",
      "updateChatPosition",
      "updateOption",
      "updateFile",
      "updateConnectionState",
      "updateAuthorizationState",
    ];
    for (const type of types) expect(filter.keep(update({ "@type": type, chat_id: -100 }))).toBe(false);
  });

  test("keeps messages in groups and private chats, drops channels and secret chats", () => {
    const filter = createUpdateFilter("user");
    expect(filter.keep(newChat(-1001, supergroup(false)))).toBe(true);
    expect(filter.keep(newChat(-1002, supergroup(true)))).toBe(false);
    expect(filter.keep(newChat(-3, basicGroup))).toBe(true);
    expect(filter.keep(newChat(4, privateChat))).toBe(true);
    expect(filter.keep(newChat(5, secretChat))).toBe(false);

    expect(filter.keep(newMessage(-1001))).toBe(true);
    expect(filter.keep(newMessage(-3))).toBe(true);
    expect(filter.keep(newMessage(4))).toBe(true);
    expect(filter.keep(newMessage(-1002))).toBe(false);
    expect(filter.keep(newMessage(5))).toBe(false);
    expect(filter.keep(update({ "@type": "updateMessageContent", chat_id: -1002, message_id: 1 }))).toBe(
      false,
    );
    expect(filter.keep(update({ "@type": "updateMessageEdited", chat_id: -1001, message_id: 1 }))).toBe(true);
  });

  test("throws on an update for a chat whose updateNewChat it has not seen", () => {
    expect(() => createUpdateFilter("user").keep(newMessage(-1009))).toThrow(/before its updateNewChat/);
    expect(() => createUpdateFilter("bot").keep(newMessage(9))).toThrow(/before its updateNewChat/);
  });

  test("keeps only permanent deletions", () => {
    const filter = createUpdateFilter("user");
    filter.keep(newChat(-1001, supergroup(false)));
    const deletion = (is_permanent: boolean, from_cache: boolean): td.updateDeleteMessages => ({
      "@type": "updateDeleteMessages",
      chat_id: -1001,
      message_ids: [1],
      is_permanent,
      from_cache,
    });
    expect(filter.keep(deletion(true, false))).toBe(true);
    expect(filter.keep(deletion(false, true))).toBe(false);
    expect(filter.keep(deletion(false, false))).toBe(false);
  });

  test("bot keeps in groups only what the user account cannot see", () => {
    const filter = createUpdateFilter("bot");
    expect(filter.keep(newChat(-1001, supergroup(false)))).toBe(false);
    expect(filter.keep(newMessage(-1001))).toBe(false);
    expect(filter.keep(update({ "@type": "updateMessageEdited", chat_id: -1001, message_id: 1 }))).toBe(
      false,
    );
    expect(filter.keep(update({ "@type": "updateChatTitle", chat_id: -1001, title: "x" }))).toBe(false);
    expect(
      filter.keep(
        update({
          "@type": "updateDeleteMessages",
          chat_id: -1001,
          message_ids: [1],
          is_permanent: true,
          from_cache: false,
        }),
      ),
    ).toBe(false);

    const sent = { "@type": "message", id: 2 << 20, chat_id: -1001 };
    expect(
      filter.keep(update({ "@type": "updateMessageSendSucceeded", message: sent, old_message_id: 1 })),
    ).toBe(true);
    expect(
      filter.keep(update({ "@type": "updateMessageSendFailed", message: sent, old_message_id: 1 })),
    ).toBe(true);
    expect(filter.keep(update({ "@type": "updateMessageReaction", chat_id: -1001, message_id: 1 }))).toBe(
      true,
    );
    expect(filter.keep(update({ "@type": "updateMessageReactions", chat_id: -1001, message_id: 1 }))).toBe(
      true,
    );
    expect(filter.keep(update({ "@type": "updateChatMember", chat_id: -1001 }))).toBe(true);
  });

  test("bot keeps its private chats", () => {
    const filter = createUpdateFilter("bot");
    expect(filter.keep(newChat(4, privateChat))).toBe(true);
    expect(filter.keep(newMessage(4))).toBe(true);
  });

  test("keeps updateUser only when the name changes", () => {
    const filter = createUpdateFilter("user");
    expect(filter.keep(user(7, "Alice"))).toBe(true);
    expect(filter.keep(user(7, "Alice"))).toBe(false);
    expect(filter.keep(user(7, "Alicia"))).toBe(true);
    expect(filter.keep(user(8, "Alice"))).toBe(true);
  });
});
