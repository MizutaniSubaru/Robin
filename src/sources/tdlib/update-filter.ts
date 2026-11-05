import type { TdObject } from "./ffi.ts";

// Decides which TDLib updates are worth persisting in raw_updates.
// Kept: whatever the adapter needs to rebuild events (messages, edits, deletions, reactions,
// membership, chat and user names, send results). Everything else is dropped: typing and presence,
// read state, unread counters, chat list order, notifications, files, options, stickers, themes,
// calls, stories, payments, and bot features Robin does not use
export interface UpdateFilter {
  keep(update: TdObject): boolean;
}

type ChatKind = "private" | "group" | "channel" | "secret";

// Updates kept for chats Robin can take part in, keyed by how to read their chat id
const CHAT_UPDATES: Record<string, (update: TdObject) => unknown> = {
  updateNewMessage: (u) => (u.message as TdObject).chat_id,
  updateMessageSendSucceeded: (u) => (u.message as TdObject).chat_id,
  updateMessageSendFailed: (u) => (u.message as TdObject).chat_id,
  updateMessageContent: (u) => u.chat_id,
  updateMessageEdited: (u) => u.chat_id,
  updateDeleteMessages: (u) => u.chat_id,
  // Aggregated reactions as the user account sees them; also fires on view and reply counts
  updateMessageInteractionInfo: (u) => u.chat_id,
  // Bot account only
  updateMessageReaction: (u) => u.chat_id,
  updateMessageReactions: (u) => u.chat_id,
  updateChatMember: (u) => u.chat_id,
  updateChatTitle: (u) => u.chat_id,
};

// One per account: chat kinds come from that account's updateNewChat,
// which TDLib guarantees before any other update about the chat
export function createUpdateFilter(): UpdateFilter {
  const chatKinds = new Map<number, ChatKind>();
  // Last stored name per user, so repeated updateUser without a rename is dropped
  const userNames = new Map<number, string>();

  // A chat not seen yet is kept rather than lost
  function isRelevant(chatId: unknown): boolean {
    const kind = chatKinds.get(Number(chatId));
    return kind !== "channel" && kind !== "secret";
  }

  function keepNewChat(chat: TdObject): boolean {
    const kind = chatKind(chat.type as TdObject);
    chatKinds.set(Number(chat.id), kind);
    return kind !== "channel" && kind !== "secret";
  }

  function keepUser(user: TdObject): boolean {
    const usernames = user.usernames as { active_usernames?: string[] } | undefined;
    const name = JSON.stringify([user.first_name, user.last_name, usernames?.active_usernames ?? []]);
    const id = Number(user.id);
    if (userNames.get(id) === name) return false;
    userNames.set(id, name);
    return true;
  }

  return {
    keep(update) {
      const type = update["@type"];
      if (type === "updateNewChat") return keepNewChat(update.chat as TdObject);
      if (type === "updateUser") return keepUser(update.user as TdObject);
      // Non-permanent deletions only evict messages from TDLib's cache
      if (type === "updateDeleteMessages" && (!update.is_permanent || update.from_cache)) return false;
      const chatId = CHAT_UPDATES[type];
      return chatId !== undefined && isRelevant(chatId(update));
    },
  };
}

function chatKind(type: TdObject): ChatKind {
  switch (type["@type"]) {
    case "chatTypePrivate":
      return "private";
    case "chatTypeSecret":
      return "secret";
    case "chatTypeSupergroup":
      return type.is_channel ? "channel" : "group";
    default:
      return "group";
  }
}
