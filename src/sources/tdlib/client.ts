import type { Logger } from "../../log/index.ts";
import { TdClosedError } from "./errors.ts";
import type { TdObject } from "./ffi.ts";
import type { SendOptions, TdHub } from "./hub.ts";

export type UpdateListener = (update: TdObject, receivedAt: number) => void;

export interface TdClient {
  readonly id: number;
  // Resolves on authorizationStateClosed, a close timeout, or the hub stopping
  readonly closed: Promise<void>;
  readonly authorizationState: TdObject | undefined;
  // Bumped on every authorization state update, including repeats of the same state
  readonly authorizationVersion: number;
  // The session was terminated (logOut, or revoked from another device): it cannot come back by itself
  readonly loggedOut: boolean;
  readonly isOpen: boolean;
  invoke(request: TdObject, options?: SendOptions): Promise<TdObject>;
  onUpdate(listener: UpdateListener): () => void;
  // Resolves once an authorization update newer than `version` has arrived (or the client closed)
  waitForAuthorizationChange(version: number): Promise<void>;
  // Asks TDLib to flush and close; resolves on authorizationStateClosed or after a timeout
  close(timeoutMs?: number): Promise<void>;
}

const CLOSE_TIMEOUT_MS = 15_000;

// One TDLib instance. Lives until authorizationStateClosed; after that a new client is needed
export function createTdClient(hub: TdHub, log: Logger): TdClient {
  const listeners = new Set<UpdateListener>();
  const authWaiters = new Set<() => void>();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  let authState: TdObject | undefined;
  let authVersion = 0;
  let sawLoggingOut = false;
  let isClosed = false;

  const id = hub.registerClient({ deliver: handle, detached: finish });

  function invoke(request: TdObject, options?: SendOptions): Promise<TdObject> {
    if (isClosed) return Promise.reject(new TdClosedError(`Client ${id} is closed`));
    return hub.send(id, request, options);
  }

  function handle(message: TdObject, receivedAt: number): void {
    const isAuthUpdate = message["@type"] === "updateAuthorizationState";
    if (isAuthUpdate) {
      authState = message.authorization_state as TdObject;
      authVersion++;
      if (authState["@type"] === "authorizationStateLoggingOut") sawLoggingOut = true;
    }

    for (const listener of listeners) {
      try {
        listener(message, receivedAt);
      } catch (error) {
        log.error("Update listener failed on {type}", { type: message["@type"], error });
      }
    }

    if (isAuthUpdate) {
      if (authState?.["@type"] === "authorizationStateClosed") finish("authorizationStateClosed");
      for (const waiter of [...authWaiters]) waiter();
    }
  }

  function finish(reason: string): void {
    if (isClosed) return;
    isClosed = true;
    hub.unregisterClient(id, reason);
    for (const waiter of [...authWaiters]) waiter();
    markClosed();
  }

  // TDLib creates the instance lazily and stays silent until it gets its first request
  invoke({ "@type": "getOption", name: "version" }).catch((error: unknown) => {
    log.warn("Initial request failed", { error });
  });

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
      invoke({ "@type": "close" }).catch((error: unknown) => {
        if (!(error instanceof TdClosedError)) log.warn("close request failed", { error });
      });
      const done = await Promise.race([closed.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
      if (!done) {
        log.error("Client {clientId} did not close within {timeoutMs} ms", { clientId: id, timeoutMs });
        finish("close timed out");
      }
    },
  };
}
