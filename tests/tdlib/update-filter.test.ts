import { describe, expect, test } from "bun:test";

import { createUpdateFilter } from "../../src/sources/tdlib/update-filter.ts";

const newChat = (id: number, type: Record<string, unknown>) => ({
  "@type": "updateNewChat",
  chat: { "@type": "chat", id, type, title: `chat ${id}` },
});
const newMessage = (chatId: number) => ({
  "@type": "updateNewMessage",
  message: { "@type": "message", id: 1 << 20, chat_id: chatId },
});
const user = (id: number, firstName: string) => ({
  "@type": "updateUser",
  user: { "@type": "user", id, first_name: firstName, last_name: "", usernames: { active_usernames: ["a"] } },
});

describe("createUpdateFilter", () => {
  test("drops noise updates", () => {
    const filter = createUpdateFilter();
    for (const type of [
      "updateChatAction",
      "updateUserStatus",
      "updateChatReadInbox",
      "updateChatLastMessage",
      "updateChatPosition",
      "updateOption",
      "updateFile",
      "updateConnectionState",
      "updateAuthorizationState",
    ]) {
      expect(filter.keep({ "@type": type, chat_id: -100 })).toBe(false);
    }
  });

  test("keeps messages in groups and private chats, drops channels and secret chats", () => {
    const filter = createUpdateFilter();
    expect(filter.keep(newChat(-1001, { "@type": "chatTypeSupergroup", is_channel: false }))).toBe(true);
    expect(filter.keep(newChat(-1002, { "@type": "chatTypeSupergroup", is_channel: true }))).toBe(false);
    expect(filter.keep(newChat(-3, { "@type": "chatTypeBasicGroup" }))).toBe(true);
    expect(filter.keep(newChat(4, { "@type": "chatTypePrivate" }))).toBe(true);
    expect(filter.keep(newChat(5, { "@type": "chatTypeSecret" }))).toBe(false);

    expect(filter.keep(newMessage(-1001))).toBe(true);
    expect(filter.keep(newMessage(-3))).toBe(true);
    expect(filter.keep(newMessage(4))).toBe(true);
    expect(filter.keep(newMessage(-1002))).toBe(false);
    expect(filter.keep(newMessage(5))).toBe(false);
    expect(filter.keep({ "@type": "updateMessageContent", chat_id: -1002, message_id: 1 })).toBe(false);
    expect(filter.keep({ "@type": "updateMessageEdited", chat_id: -1001, message_id: 1 })).toBe(true);
  });

  test("keeps updates for a chat it has not seen", () => {
    expect(createUpdateFilter().keep(newMessage(-1009))).toBe(true);
  });

  test("keeps only permanent deletions", () => {
    const filter = createUpdateFilter();
    const deletion = { "@type": "updateDeleteMessages", chat_id: -1001, message_ids: [1] };
    expect(filter.keep({ ...deletion, is_permanent: true, from_cache: false })).toBe(true);
    expect(filter.keep({ ...deletion, is_permanent: false, from_cache: true })).toBe(false);
    expect(filter.keep({ ...deletion, is_permanent: false, from_cache: false })).toBe(false);
  });

  test("keeps updateUser only when the name changes", () => {
    const filter = createUpdateFilter();
    expect(filter.keep(user(7, "Alice"))).toBe(true);
    expect(filter.keep(user(7, "Alice"))).toBe(false);
    expect(filter.keep(user(7, "Alicia"))).toBe(true);
    expect(filter.keep(user(8, "Alice"))).toBe(true);
  });
});
