import type { Content, ContentPart, ReplyRef } from "../../core/events/index.ts";
import type { ChatType, InboundEvent, InboundItem, SourceBody } from "../../core/store/index.ts";
import type * as td from "../../tdlib-api/td-api.ts";
import type { AccountName } from "./account.ts";
import { fromTdEntities } from "./entities.ts";
import { botPrivateChatKey, chatSenderKey, groupChatKey, parseUserKey, userKey } from "./keys.ts";
import { toServerMessageId } from "./message-id.ts";

// Turns the TDLib updates of both accounts into Robin's inbound items.
//
// It is fed exactly what raw_updates stores (the update filter's output), and its only memory is what
// those updates taught it (chat kinds and titles, user names, an edit's new content), so running it
// over raw_updates again rebuilds the same events.
//
// Served: supergroups through the user account, private chats through the bot. Basic groups (their
// message ids differ per account) and everything else are left out; raw_updates keeps them for later.
// Messages Robin sent itself never come in here: they are Pipeline B's
export interface TelegramAdapter {
  adapt(account: AccountName, update: td.Update, receivedAt: number): InboundItem[];
}

export interface AdapterOptions {
  // Messages from the bot are Robin's own; the user account sees them as anyone else's
  botUserId: number;
}

type ChatKind = "private" | "basic_group" | "supergroup" | "channel" | "secret";

interface ChatEntry {
  kind: ChatKind;
  title: string;
}

interface AccountDirectory {
  chats: Map<number, ChatEntry>;
  // New content waiting for the updateMessageEdited that dates it. Not every content update gets one
  // with a date: a link preview or a reply markup change ends with edit_date 0, or with no
  // updateMessageEdited at all, so the oldest entries are dropped beyond PENDING_CONTENT_LIMIT
  editedContent: Map<string, td.MessageContent>;
}

// A real edit's updateMessageEdited follows its content almost at once; this only bounds the
// entries that never get one
const PENDING_CONTENT_LIMIT = 1000;

export function createTelegramAdapter({ botUserId }: AdapterOptions): TelegramAdapter {
  // User ids and names are the same for both accounts
  const users = new Map<number, string>();
  const accounts: Record<AccountName, AccountDirectory> = {
    user: { chats: new Map(), editedContent: new Map() },
    bot: { chats: new Map(), editedContent: new Map() },
  };

  function userName(userId: number): string {
    const name = users.get(userId);
    // TDLib sends updateUser before a user id appears anywhere else
    if (name === undefined) throw new Error(`User ${userId} appeared before its updateUser`);
    return name;
  }

  function chatEntry(account: AccountName, chatId: number): ChatEntry {
    const entry = accounts[account].chats.get(chatId);
    // TDLib sends updateNewChat before a chat id appears anywhere else
    if (!entry) throw new Error(`Chat ${chatId} appeared before its updateNewChat (${account})`);
    return entry;
  }

  // The chat key when this account serves the chat, undefined otherwise
  function served(account: AccountName, chatId: number): string | undefined {
    const { kind } = chatEntry(account, chatId);
    if (account === "user" && kind === "supergroup") return groupChatKey(chatId);
    if (account === "bot" && kind === "private") return botPrivateChatKey(chatId);
    return undefined;
  }

  function chatInfo(account: AccountName, chatId: number): InboundItem[] {
    const key = served(account, chatId);
    if (key === undefined) return [];
    const { kind, title } = chatEntry(account, chatId);
    const chatType: ChatType = kind === "private" ? "private" : "supergroup";
    return [{ type: "chat", chat: key, chatType, title, inboundAccount: account }];
  }

  function content(value: td.MessageContent, names: Record<string, string>): Content | undefined {
    const parts = contentParts(value);
    if (parts === undefined) return undefined;
    for (const part of parts) {
      if (part.type !== "text") continue;
      for (const entity of part.entities) {
        const id = entity.type === "mention_user" ? parseUserKey(entity.user) : undefined;
        if (id !== undefined) names[userKey(id)] = userName(id);
      }
    }
    return parts.length > 0 ? parts : undefined;
  }

  function sender(account: AccountName, id: td.MessageSender): { key: string; name: string } | undefined {
    switch (id["@type"]) {
      case "messageSenderUser":
        if (id.user_id === botUserId) return undefined;
        return { key: userKey(id.user_id), name: userName(id.user_id) };
      case "messageSenderChat":
        return { key: chatSenderKey(id.chat_id), name: chatEntry(account, id.chat_id).title };
    }
  }

  function forwardedFrom(account: AccountName, info: td.messageForwardInfo | undefined): string | null {
    if (!info) return null;
    const origin = info.origin;
    switch (origin["@type"]) {
      case "messageOriginUser":
        return userName(origin.sender_user_id);
      case "messageOriginHiddenUser":
        return origin.sender_name;
      case "messageOriginChat":
        return withSignature(chatEntry(account, origin.sender_chat_id).title, origin.author_signature);
      case "messageOriginChannel":
        return withSignature(chatEntry(account, origin.chat_id).title, origin.author_signature);
    }
  }

  function newMessage(account: AccountName, message: td.message, receivedAt: number): InboundItem[] {
    const chat = served(account, message.chat_id);
    // Outgoing: the bot's own messages are Pipeline B's; the user account never speaks
    if (chat === undefined || message.is_outgoing) return [];
    const messageId = toServerMessageId(message.id);
    if (messageId === undefined) return [];
    const from = sender(account, message.sender_id);
    if (!from) return [];
    const names: Record<string, string> = { [from.key]: from.name };
    const body = content(message.content, names);
    if (!body) return [];
    return [
      inbound(chat, account, receivedAt, message.date, names, {
        kind: "message.created",
        messageId: String(messageId),
        sender: from.key,
        senderName: from.name,
        replyTo: replyRef(message),
        forwardedFrom: forwardedFrom(account, message.forward_info),
        content: body,
      }),
    ];
  }

  function edited(account: AccountName, update: td.updateMessageEdited, receivedAt: number): InboundItem[] {
    const key = `${update.chat_id}:${update.message_id}`;
    const newContent = accounts[account].editedContent.get(key);
    accounts[account].editedContent.delete(key);
    const chat = served(account, update.chat_id);
    const messageId = toServerMessageId(update.message_id);
    // Without new content only the reply markup changed. Without an edit date nobody edited the
    // message: TDLib refreshed it (a link preview came in, a button changed)
    if (chat === undefined || messageId === undefined || !newContent || update.edit_date === 0) return [];
    const names: Record<string, string> = {};
    const body = content(newContent, names);
    if (!body) return [];
    return [
      inbound(chat, account, receivedAt, update.edit_date, names, {
        kind: "message.edited",
        messageId: String(messageId),
        // The update's receive time names it: raw_updates keeps it with the update, and in µs two
        // edits of one message never share it, while edit_date does within a second
        editKey: String(receivedAt),
        content: body,
      }),
    ];
  }

  function deleted(account: AccountName, update: td.updateDeleteMessages, receivedAt: number): InboundItem[] {
    const chat = served(account, update.chat_id);
    // Not permanent: TDLib only evicted them from its cache
    if (chat === undefined || !update.is_permanent || update.from_cache) return [];
    return update.message_ids.flatMap((id) => {
      const messageId = toServerMessageId(id);
      if (messageId === undefined) return [];
      return [
        inbound(
          chat,
          account,
          receivedAt,
          null,
          {},
          { kind: "message.deleted", messageId: String(messageId) },
        ),
      ];
    });
  }

  return {
    adapt(account, update, receivedAt) {
      switch (update["@type"]) {
        case "updateNewChat": {
          accounts[account].chats.set(update.chat.id, {
            kind: chatKind(update.chat.type),
            title: update.chat.title,
          });
          return chatInfo(account, update.chat.id);
        }
        case "updateChatTitle": {
          const entry = chatEntry(account, update.chat_id);
          entry.title = update.title;
          return chatInfo(account, update.chat_id);
        }
        case "updateUser": {
          const name = displayName(update.user);
          const previous = users.get(update.user.id);
          users.set(update.user.id, name);
          if (previous === undefined || previous === name || update.user.id === botUserId) return [];
          return [{ type: "profile", user: userKey(update.user.id), name, receivedAt }];
        }
        case "updateNewMessage":
          return newMessage(account, update.message, receivedAt);
        case "updateMessageContent": {
          const pending = accounts[account].editedContent;
          const key = `${update.chat_id}:${update.message_id}`;
          // Re-inserted, so the map stays in arrival order and the oldest entry goes first
          pending.delete(key);
          pending.set(key, update.new_content);
          if (pending.size > PENDING_CONTENT_LIMIT) {
            const oldest = pending.keys().next();
            if (!oldest.done) pending.delete(oldest.value);
          }
          return [];
        }
        case "updateMessageEdited":
          return edited(account, update, receivedAt);
        case "updateDeleteMessages":
          return deleted(account, update, receivedAt);
        // Reactions, membership and send results are not modelled as inbound events yet
        default:
          return [];
      }
    },
  };
}

function inbound(
  chat: string,
  account: AccountName,
  receivedAt: number,
  serverDate: number | null,
  users: Record<string, string>,
  body: SourceBody,
): InboundEvent {
  // TDLib uses 0 for "no date"
  return { type: "event", chat, account, receivedAt, serverDate: serverDate || null, body, users };
}

function replyRef(message: td.message): ReplyRef | null {
  const reply = message.reply_to;
  if (reply?.["@type"] !== "messageReplyToMessage") return null;
  const quote = reply.quote?.text.text ?? null;
  const target = reply.message_id === 0 ? undefined : toServerMessageId(reply.message_id);
  if (reply.chat_id !== message.chat_id || target === undefined) return { type: "external", quote };
  // An automatic quote is just the start of the target, which the model can read there
  return { type: "message", messageId: String(target), quote: reply.quote?.is_manual ? quote : null };
}

// Message contents Robin keeps; undefined for service messages (joins, pins, title changes, ...),
// which are not modelled as messages
function contentParts(value: td.MessageContent): ContentPart[] | undefined {
  const caption = (text: td.formattedText): ContentPart[] =>
    text.text ? [{ type: "text", text: text.text, entities: fromTdEntities(text.entities) }] : [];
  const media = (kind: string, text?: td.formattedText): ContentPart[] => [
    { type: "unsupported", kind },
    ...(text ? caption(text) : []),
  ];
  switch (value["@type"]) {
    case "messageText":
      return caption(value.text);
    case "messageAnimatedEmoji":
      return [{ type: "text", text: value.emoji, entities: [] }];
    case "messageSticker":
      return [{ type: "sticker", emoji: value.sticker.emoji }];
    case "messagePhoto":
      return media("photo", value.caption);
    case "messageAnimation":
      return media("animation", value.caption);
    case "messageVideo":
      return media("video", value.caption);
    case "messageAudio":
      return media("audio", value.caption);
    case "messageDocument":
      return media("document", value.caption);
    case "messageVoiceNote":
      return media("voice_note", value.caption);
    case "messagePaidMedia":
      return media("paid_media", value.caption);
    case "messageVideoNote":
      return media("video_note");
    case "messagePoll":
      return media("poll");
    case "messageLocation":
    case "messageLiveLocation":
      return media("location");
    case "messageVenue":
      return media("venue");
    case "messageContact":
      return media("contact");
    case "messageDice":
      return media("dice");
    case "messageGame":
      return media("game");
    case "messageStory":
      return media("story");
    case "messageChecklist":
      return media("checklist");
    case "messageInvoice":
      return media("invoice");
    default:
      return undefined;
  }
}

function displayName(user: td.user): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

function withSignature(title: string, signature: string): string {
  return signature ? `${title} (${signature})` : title;
}

function chatKind(type: td.ChatType): ChatKind {
  switch (type["@type"]) {
    case "chatTypePrivate":
      return "private";
    case "chatTypeSecret":
      return "secret";
    case "chatTypeBasicGroup":
      return "basic_group";
    case "chatTypeSupergroup":
      return type.is_channel ? "channel" : "supergroup";
  }
}
