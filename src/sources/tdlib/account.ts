// Account: one logged-in Telegram account (user or bot), owning a single TDLib client id on the hub.
// Logs the client in, verifies its identity and delivers its updates to listeners. If TDLib closes
// it unexpectedly after startup, reports through onFatal so the process supervisor restarts Robin

import type { Logger } from "../../log/index.ts";
import type * as td from "../../tdlib-api/td-api.ts";
import { type AuthClient, authorize, type Credentials } from "./auth.ts";
import { TdClosedError, TdTimeoutError } from "./errors.ts";
import type { SendOptions, TdHub } from "./hub.ts";

export type UpdateListener = (update: td.Update, receivedAt: number) => void;
export type AccountName = "user" | "bot";

export interface AccountOptions {
  name: AccountName;
  credentials: Credentials;
  parameters: td.setTdlibParameters;
  // Called when the account closes unexpectedly after starting (session terminated or TDLib closed);
  // the caller should exit
  onFatal(error: Error): void;
}

export interface AccountIdentity {
  userId: number;
  username: string | undefined;
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
  invoke<R extends td.Request>(request: R, options?: SendOptions): Promise<td.ResultOf<R>>;
  start(): Promise<void>;
  close(timeoutMs?: number): Promise<void>;
}

const CLOSE_TIMEOUT_MS = 15_000;

export function createTdAccount(hub: TdHub, options: AccountOptions, log: Logger): TdAccount {
  const { name } = options;
  const listeners = new Set<UpdateListener>();
  const authWaiters = new Set<() => void>();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();

  let clientId: number | undefined;
  let authState: td.AuthorizationState | undefined;
  let authVersion = 0;
  let sawLoggingOut = false;
  let clientClosed = false;
  let closing = false;
  let ready = false;
  let identity: AccountIdentity | undefined;

  function rawInvoke<R extends td.Request>(request: R, sendOptions?: SendOptions): Promise<td.ResultOf<R>> {
    if (clientId === undefined || clientClosed) {
      return Promise.reject(new TdClosedError(`Account ${name} is closed`));
    }
    return hub.send(clientId, request, sendOptions);
  }

  function handle(update: td.Update, receivedAt: number): void {
    const auth = update["@type"] === "updateAuthorizationState" ? update.authorization_state : undefined;
    if (auth) {
      authState = auth;
      authVersion++;
      if (auth["@type"] === "authorizationStateLoggingOut") sawLoggingOut = true;
    }

    try {
      notifyListeners(listeners, update, receivedAt);
    } finally {
      // Authorization tracking must not depend on listeners: close() and authorize() wait on it
      if (auth) {
        if (auth["@type"] === "authorizationStateClosed") {
          const wasReady = ready;
          finish("authorizationStateClosed");
          if (wasReady && !closing) {
            options.onFatal(
              new Error(
                sawLoggingOut
                  ? `${name} session was terminated; log in again with \`bun run login --account ${name}\``
                  : `${name} client closed unexpectedly`,
              ),
            );
          }
        }
        for (const waiter of [...authWaiters]) waiter();
      }
    }
  }

  function finish(reason: string): void {
    if (clientClosed) return;
    clientClosed = true;
    ready = false;
    if (clientId !== undefined) hub.unregisterClient(clientId, reason);
    for (const waiter of [...authWaiters]) waiter();
    markClosed();
  }

  const authClient: AuthClient = {
    get authorizationState() {
      return authState;
    },
    get authorizationVersion() {
      return authVersion;
    },
    get isOpen() {
      return clientId !== undefined && !clientClosed;
    },
    invoke: rawInvoke,
    waitForAuthorizationChange(version) {
      if (authVersion > version || clientClosed) return Promise.resolve();
      return new Promise((resolve) => {
        const waiter = () => {
          if (authVersion > version || clientClosed) {
            authWaiters.delete(waiter);
            resolve();
          }
        };
        authWaiters.add(waiter);
      });
    },
  };

  // Guards against swapped database directories: the user slot must hold a user, the bot slot a bot
  async function verifyIdentity(): Promise<AccountIdentity> {
    const me = await rawInvoke({ "@type": "getMe" });
    const isBot = me.type["@type"] === "userTypeBot";
    if (isBot !== (name === "bot")) {
      throw new Error(`Account ${name} is logged in as a ${isBot ? "bot" : "user"}`);
    }
    return {
      userId: me.id,
      username: me.usernames?.active_usernames[0],
      displayName: [me.first_name, me.last_name].filter(Boolean).join(" "),
      isBot,
    };
  }

  async function closeClient(timeoutMs: number): Promise<void> {
    if (clientId === undefined || clientClosed) return;
    // authorizationStateClosed can unregister the client before the close request is answered
    const request = rawInvoke({ "@type": "close" }).catch(ignoreClosed);
    const done = await Promise.race([
      Promise.all([request, closed]).then(() => true),
      Bun.sleep(timeoutMs).then(() => false),
    ]);
    if (!done) {
      finish("close timed out");
      throw new TdTimeoutError("close", timeoutMs);
    }
  }

  async function start(): Promise<void> {
    if (clientId !== undefined) throw new Error(`Account ${name} has already started`);
    if (closing) throw new TdClosedError(`Account ${name} is closing`);

    clientId = hub.registerClient({ deliver: handle, detached: finish });
    // TDLib creates the instance lazily and stays silent until it gets its first request.
    // The client may be closed before the answer arrives; that is the only failure to expect
    rawInvoke({ "@type": "getOption", name: "version" }).catch(ignoreClosed);

    let me: AccountIdentity;
    try {
      await authorize(authClient, options.parameters, options.credentials, log);
      me = await verifyIdentity();
    } catch (error) {
      // The start failure is what callers act on, so a failing close must not replace it
      await closeClient(CLOSE_TIMEOUT_MS).catch((closeError: unknown) => {
        log.error("{account} client did not close after a failed start", {
          account: name,
          error: closeError,
        });
      });
      throw error;
    }
    identity = me;
    ready = true;
    log.info("{account} logged in as {name}", {
      account: name,
      name: me.username ? `@${me.username}` : me.displayName,
      userId: me.userId,
    });
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
      if (!ready) return Promise.reject(new TdClosedError(`Account ${name} is not ready`));
      return rawInvoke(request, sendOptions);
    },
    start,
    async close(timeoutMs = CLOSE_TIMEOUT_MS) {
      closing = true;
      ready = false;
      await closeClient(timeoutMs);
    },
  };
}

function ignoreClosed(error: unknown): void {
  if (!(error instanceof TdClosedError)) throw error;
}

// Every listener sees the update even when an earlier one throws; the failure is rethrown afterwards
// so the hub still reports it
function notifyListeners(listeners: Iterable<UpdateListener>, update: td.Update, receivedAt: number): void {
  const errors: unknown[] = [];
  for (const listener of listeners) {
    try {
      listener(update, receivedAt);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, `${errors.length} listeners failed on ${update["@type"]}`);
}
