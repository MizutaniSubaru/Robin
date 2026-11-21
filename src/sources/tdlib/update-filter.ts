// Update filter: decides which TDLib updates Robin keeps (stored in raw_updates, then adapted into
// events). Everything else is dropped.
//
// Kept: what the adapter needs to build events, i.e. messages, edits, deletions, reactions,
// membership, chat and user names and send results. Dropped: typing and presence, read state,
// unread counters, chat list order, notifications, files, options, stickers, themes, calls, stories,
// payments, and bot features Robin does not use.
//
// Both accounts keep every non-secret chat's updateNewChat and updateChatTitle: the adapter knows
// chats per account, and an update it keeps for a chat must be preceded by that chat's introduction
// in the same account's raw_updates, or a replay cannot tell what the chat is.
//
// Groups come from the user account; there the bot keeps only what the user cannot see (its own
// send results, bot-only reaction and member updates). The bot also keeps its private chats

import type * as td from "../../tdlib-api/td-api.ts";
import type { AccountName } from "./account.ts";

export interface UpdateFilter {
  keep(update: td.Update): boolean;
}

type ChatKind = "private" | "group" | "channel" | "secret";

const BOT_GROUP_UPDATES = new Set<td.Update["@type"]>([
  "updateMessageSendSucceeded",
  "updateMessageSendFailed",
  "updateMessageReaction",
  "updateMessageReactions",
  "updateChatMember",
]);

export function createUpdateFilter(account: AccountName): UpdateFilter {
  const isBot = account === "bot";
  const chatKinds = new Map<number, ChatKind>();
  // Last stored name per user, so repeated updateUser without a rename is dropped
  const userNames = new Map<number, string>();

  function keepChatUpdate(type: td.Update["@type"], chatId: number): boolean {
    const kind = chatKinds.get(chatId);
    // TDLib introduces a chat before using it. Should it ever not, the update is kept rather than
    // thrown on: raw_updates keeps the record, and the adapter skips what it cannot place
    if (kind === undefined) return true;
    if (kind === "secret") return false;
    // A chat's name is needed wherever it sends or forwards a message, in any chat of either account
    if (type === "updateChatTitle") return true;
    if (kind === "channel") return false;
    if (isBot && kind === "group") return BOT_GROUP_UPDATES.has(type);
    return true;
  }

  function keepNewChat(chat: td.chat): boolean {
    const kind = chatKind(chat.type);
    chatKinds.set(chat.id, kind);
    return kind !== "secret";
  }

  function keepUser(user: td.user): boolean {
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
