import type * as td from "../../tdlib-api/td-api.ts";
import type { AccountName } from "./account.ts";

// Decides which TDLib updates are worth persisting in raw_updates.
// Kept: whatever the adapter needs to rebuild events (messages, edits, deletions, reactions,
// membership, chat and user names, send results). Everything else is dropped: typing and presence,
// read state, unread counters, chat list order, notifications, files, options, stickers, themes,
// calls, stories, payments, and bot features Robin does not use.
//
// The bot runs with privacy mode off, so in groups it sees the same messages as the user account.
// The user account is the source for groups; the bot stores there only what the user cannot see
// (its own send results, bot-only reaction and member updates), plus its private chats
export interface UpdateFilter {
  keep(update: td.Update): boolean;
}

type ChatKind = "private" | "group" | "channel" | "secret";

// What the bot keeps in groups: the user account never receives these
const BOT_GROUP_UPDATES = new Set<td.Update["@type"]>([
  "updateMessageSendSucceeded",
  "updateMessageSendFailed",
  "updateMessageReaction",
  "updateMessageReactions",
  "updateChatMember",
]);

// One per account: chat kinds come from that account's updateNewChat,
// which TDLib guarantees before any other update about the chat
export function createUpdateFilter(account: AccountName): UpdateFilter {
  const isBot = account === "bot";
  const chatKinds = new Map<number, ChatKind>();
  // Last stored name per user, so repeated updateUser without a rename is dropped
  const userNames = new Map<number, string>();

  function keepChatUpdate(type: td.Update["@type"], chatId: number): boolean {
    const kind = chatKinds.get(chatId);
    if (kind === undefined) throw new Error(`${type} for chat ${chatId} arrived before its updateNewChat`);
    if (kind === "channel" || kind === "secret") return false;
    if (isBot && kind === "group") return BOT_GROUP_UPDATES.has(type);
    return true;
  }

  function keepNewChat(chat: td.chat): boolean {
    const kind = chatKind(chat.type);
    chatKinds.set(chat.id, kind);
    if (isBot) return kind === "private";
    return kind !== "channel" && kind !== "secret";
  }

  function keepUser(user: td.user): boolean {
    // usernames is null when the user has none
    const name = JSON.stringify([user.first_name, user.last_name, user.usernames?.active_usernames ?? []]);
    if (userNames.get(user.id) === name) return false;
    userNames.set(user.id, name);
    return true;
  }

  return {
    keep(update) {
      switch (update["@type"]) {
        case "updateNewChat":
          return keepNewChat(update.chat);
        case "updateUser":
          return keepUser(update.user);
        case "updateNewMessage":
        case "updateMessageSendSucceeded":
        case "updateMessageSendFailed":
          return keepChatUpdate(update["@type"], update.message.chat_id);
        case "updateDeleteMessages":
          // Non-permanent deletions only evict messages from TDLib's cache
          if (!update.is_permanent || update.from_cache) return false;
          return keepChatUpdate(update["@type"], update.chat_id);
        case "updateMessageContent":
        case "updateMessageEdited":
        // Aggregated reactions as the user account sees them; also fires on view and reply counts
        case "updateMessageInteractionInfo":
        // Bot account only
        case "updateMessageReaction":
        case "updateMessageReactions":
        case "updateChatMember":
        case "updateChatTitle":
          return keepChatUpdate(update["@type"], update.chat_id);
        default:
          return false;
      }
    },
  };
}

function chatKind(type: td.ChatType): ChatKind {
  switch (type["@type"]) {
    case "chatTypePrivate":
      return "private";
    case "chatTypeSecret":
      return "secret";
    case "chatTypeBasicGroup":
      return "group";
    case "chatTypeSupergroup":
      return type.is_channel ? "channel" : "group";
  }
}
