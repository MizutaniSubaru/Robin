import type * as td from "../../tdlib-api/td-api.ts";
import { TdClosedError, TdTimeoutError } from "./errors.ts";
import type { SendOptions, TdHub } from "./hub.ts";

export type UpdateListener = (update: td.Update, receivedAt: number) => void;

export interface TdClient {
  readonly id: number;
  // Resolves on authorizationStateClosed, a close timeout, or the hub stopping
  readonly closed: Promise<void>;
  readonly authorizationState: td.AuthorizationState | undefined;
  // Bumped on every authorization state update, including repeats of the same state
  readonly authorizationVersion: number;
  // The session was terminated (logOut, or revoked from another device): it cannot come back by itself
  readonly loggedOut: boolean;
  readonly isOpen: boolean;
  invoke<R extends td.Request>(request: R, options?: SendOptions): Promise<td.ResultOf<R>>;
  onUpdate(listener: UpdateListener): () => void;
  // Resolves once an authorization update newer than `version` has arrived (or the client closed)
  waitForAuthorizationChange(version: number): Promise<void>;
  // Asks TDLib to flush and close; resolves on authorizationStateClosed, throws TdTimeoutError after timeoutMs
  close(timeoutMs?: number): Promise<void>;
}

const CLOSE_TIMEOUT_MS = 15_000;

// One TDLib instance. Lives until authorizationStateClosed; after that a new client is needed
export function createTdClient(hub: TdHub): TdClient {
  const listeners = new Set<UpdateListener>();
  const authWaiters = new Set<() => void>();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  let authState: td.AuthorizationState | undefined;
  let authVersion = 0;
  let sawLoggingOut = false;
  let isClosed = false;

  const id = hub.registerClient({ deliver: handle, detached: finish });

  function invoke<R extends td.Request>(request: R, options?: SendOptions): Promise<td.ResultOf<R>> {
    if (isClosed) return Promise.reject(new TdClosedError(`Client ${id} is closed`));
    return hub.send(id, request, options);
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
        if (auth["@type"] === "authorizationStateClosed") finish("authorizationStateClosed");
        for (const waiter of [...authWaiters]) waiter();
      }
    }
  }

  function finish(reason: string): void {
    if (isClosed) return;
    isClosed = true;
    hub.unregisterClient(id, reason);
    for (const waiter of [...authWaiters]) waiter();
    markClosed();
  }

  // TDLib creates the instance lazily and stays silent until it gets its first request.
  // The client may be closed before the answer arrives; that is the only failure to expect
  invoke({ "@type": "getOption", name: "version" }).catch(ignoreClosed);

  return {
    id,
    closed,
    get authorizationState() {
      return authState;
    },
    get authorizationVersion() {
      return authVersion;
    },
    get loggedOut() {
      return sawLoggingOut;
    },
    get isOpen() {
      return !isClosed;
    },
    invoke,
    onUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForAuthorizationChange(version) {
      if (authVersion > version || isClosed) return Promise.resolve();
      return new Promise((resolve) => {
        const waiter = () => {
          if (authVersion > version || isClosed) {
            authWaiters.delete(waiter);
            resolve();
          }
        };
        authWaiters.add(waiter);
      });
    },
    async close(timeoutMs = CLOSE_TIMEOUT_MS) {
      if (isClosed) return;
      // authorizationStateClosed can unregister the client before the close request is answered
      const request = invoke({ "@type": "close" }).catch(ignoreClosed);
      const done = await Promise.race([
        Promise.all([request, closed]).then(() => true),
        Bun.sleep(timeoutMs).then(() => false),
      ]);
      if (!done) {
        finish("close timed out");
        throw new TdTimeoutError("close", timeoutMs);
      }
    },
  };
}

function ignoreClosed(error: unknown): void {
  if (!(error instanceof TdClosedError)) throw error;
}

// Every listener sees the update even when an earlier one throws; the failure is rethrown afterwards
// so the hub still reports it
export function notifyListeners(
  listeners: Iterable<UpdateListener>,
  update: td.Update,
  receivedAt: number,
): void {
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
