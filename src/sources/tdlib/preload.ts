// Chat preloading: has the user account's TDLib announce the chats of its main list at startup.
//
// TDLib sends a chat's updateNewChat (and its users' updateUser) only once something needs the chat.
// Loading the list up front introduces the chats Robin is likely to meet (its groups, the channels
// that post or forward into them, private chats) to the filter and the adapter before their messages
// do. Only user accounts have chat lists; the bot learns chats from its updates and loads the one it
// sends to with getChat (outbound.ts)

import type { Logger } from "../../log/index.ts";
import type { TdAccount } from "./account.ts";
import { TdError } from "./errors.ts";

// TDLib may load fewer than asked per call, so it is called until the list ends or MAX_CALLS
const PER_CALL = 100;
const MAX_CALLS = 5;

// Never throws: this is a warm-up, and without it updates still introduce their chats, only later
export async function preloadChats(account: Pick<TdAccount, "invoke">, log: Logger): Promise<void> {
  for (let call = 0; call < MAX_CALLS; call++) {
    try {
      await account.invoke({ "@type": "loadChats", chat_list: { "@type": "chatListMain" }, limit: PER_CALL });
    } catch (error) {
      // 404: every chat of the list is loaded
      if (error instanceof TdError && error.code === 404) return;
      log.warn("Preloading chats failed; they will be introduced by their updates", { error });
      return;
    }
  }
}
