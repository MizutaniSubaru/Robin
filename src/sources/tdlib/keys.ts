// Robin's keys for Telegram objects. Core treats them as opaque strings; only this module builds or
// reads them.
//
// Groups are served by the user account and spoken to by the bot, and both see the same chat id, so
// a group key has no account in it. Private chats belong to the bot: a private chat id is the other
// user's id, which the user account would share, hence the account in the key
export function groupChatKey(chatId: number): string {
  return `tg:${chatId}`;
}

export function botPrivateChatKey(chatId: number): string {
  return `tg:bot:${chatId}`;
}

export function userKey(userId: number): string {
  return `tg:user:${userId}`;
}

// A message sent on behalf of a chat (anonymous admin, linked channel)
export function chatSenderKey(chatId: number): string {
  return `tg:chat:${chatId}`;
}

// The TDLib chat id behind a chat key; Robin always speaks there through the bot
export function chatIdOf(key: string): number {
  const match = /^tg:(?:bot:)?(-?\d+)$/.exec(key);
  const chatId = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(chatId)) throw new Error(`Not a Telegram chat key: ${key}`);
  return chatId;
}

export function parseUserKey(key: string): number | undefined {
  const match = /^tg:user:(\d+)$/.exec(key);
  return match ? Number(match[1]) : undefined;
}

// The bot's user id is the part of its token before the colon. Known before the bot logs in, which
// the adapter needs: the user account may deliver the bot's own group messages first
export function botUserIdFromToken(token: string): number {
  const id = Number(token.split(":")[0]);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("Bot token does not start with the bot's user id");
  return id;
}
