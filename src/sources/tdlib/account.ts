import type { Logger } from "../../log/index.ts";
import { AuthorizationRequiredError, authorize, type Credentials } from "./auth.ts";
import { createTdClient, type TdClient, type UpdateListener } from "./client.ts";
import { TdClosedError } from "./errors.ts";
import type { TdObject } from "./ffi.ts";
import type { SendOptions, TdHub } from "./hub.ts";

export type AccountName = "user" | "bot";

export interface AccountOptions {
  name: AccountName;
  credentials: Credentials;
  // The setTdlibParameters request
  parameters: TdObject;
  // Recreate the client when TDLib closes it unexpectedly. Off for one-shot CLI commands
  autoRestart: boolean;
}

export interface AccountIdentity {
  userId: number;
  username?: string;
  displayName: string;
  isBot: boolean;
}

export interface TdAccount {
  readonly name: AccountName;
  // Throws before start() has succeeded
  readonly me: AccountIdentity;
  readonly isReady: boolean;
  // Register before start() to also see the startup updates
  onUpdate(listener: UpdateListener): () => void;
  invoke(request: TdObject, options?: SendOptions): Promise<TdObject>;
  start(): Promise<void>;
  close(): Promise<void>;
}

const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 5 * 60_000;

// A logged-in Telegram account. Owns the current client and replaces it if TDLib closes it,
// so update listeners and callers survive client restarts
export function createTdAccount(hub: TdHub, options: AccountOptions, log: Logger): TdAccount {
  const { name } = options;
  const listeners = new Set<UpdateListener>();
  let client: TdClient | undefined;
  let identity: AccountIdentity | undefined;
  let closing = false;
  let ready = false;
  let restartAttempts = 0;
  let restartTimer: Timer | undefined;

  async function connect(credentials: Credentials): Promise<void> {
    const next = createTdClient(hub, log);
    client = next;
    next.onUpdate((update, receivedAt) => {
      for (const listener of listeners) {
        try {
          listener(update, receivedAt);
        } catch (error) {
          log.error("Update listener failed on {type}", { type: update["@type"], error });
        }
      }
    });
    void next.closed.then(() => onClientClosed(next));

    let me: AccountIdentity;
    try {
      await authorize(next, options.parameters, credentials, log);
      me = await verifyIdentity(next);
    } catch (error) {
      await next.close();
      throw error;
    }
    identity = me;
    ready = true;
    restartAttempts = 0;
    log.info("{account} logged in as {name}", {
      account: name,
      name: me.username ? `@${me.username}` : me.displayName,
      userId: me.userId,
    });
  }

  // Guards against swapped database directories: the user slot must hold a user, the bot slot a bot
  async function verifyIdentity(target: TdClient): Promise<AccountIdentity> {
    const me = await target.invoke({ "@type": "getMe" });
    const isBot = (me.type as TdObject | undefined)?.["@type"] === "userTypeBot";
    if (isBot !== (name === "bot")) {
      throw new Error(`Account ${name} is logged in as a ${isBot ? "bot" : "user"}`);
    }
    const usernames = me.usernames as { active_usernames?: string[] } | undefined;
    return {
      userId: Number(me.id),
      username: usernames?.active_usernames?.[0],
      displayName: [me.first_name, me.last_name].filter(Boolean).join(" "),
      isBot,
    };
  }

  function onClientClosed(closedClient: TdClient): void {
    if (closedClient !== client) return;
    const wasReady = ready;
    ready = false;
    if (closing || !wasReady) return;

    if (closedClient.loggedOut) {
      log.error("{account} session was terminated; log in again with `bun run login --account {account}`", {
        account: name,
      });
      return;
    }
    if (!options.autoRestart) {
      log.error("{account} client closed unexpectedly", { account: name });
      return;
    }
    scheduleRestart();
  }

  function scheduleRestart(): void {
    const delayMs = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** restartAttempts);
    restartAttempts++;
    log.error("{account} client closed unexpectedly, reconnecting in {delayMs} ms", {
      account: name,
      delayMs,
    });
    restartTimer = setTimeout(() => {
      if (closing) return;
      // Never prompt during a restart: only the existing session or the bot token can be used
      const credentials: Credentials =
        options.credentials.kind === "bot" ? options.credentials : { kind: "user" };
      connect(credentials).catch((error: unknown) => {
        if (closing) return;
        if (error instanceof AuthorizationRequiredError) {
          log.error("{account} can no longer authorize: {message}", {
            account: name,
            message: error.message,
          });
          return;
        }
        log.error("{account} reconnect failed", { account: name, error });
        scheduleRestart();
      });
    }, delayMs);
  }

  return {
    name,
    get me() {
      if (!identity) throw new Error(`Account ${name} has not started`);
      return identity;
    },
    get isReady() {
      return ready;
    },
    onUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invoke(request, sendOptions) {
      if (!client || !ready) return Promise.reject(new TdClosedError(`Account ${name} is not ready`));
      return client.invoke(request, sendOptions);
    },
    start: () => connect(options.credentials),
    async close() {
      closing = true;
      ready = false;
      clearTimeout(restartTimer);
      await client?.close();
    },
  };
}
