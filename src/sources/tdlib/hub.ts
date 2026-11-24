// Hub: the one owner of libtdjson in the process. Runs a single receive worker (this file, when loaded
// off the main thread), matches TDLib's responses to the requests that asked for them (by @extra) and
// hands updates to the right client (by @client_id)

import { dlopen, FFIType } from "bun:ffi";

import type { Logger } from "../../log/index.ts";
import type * as td from "../../tdlib-api/td-api.ts";
import { TdClosedError, TdError, TdTimeoutError } from "./errors.ts";
import { openTdJson, parseTdJson, readCString, type TdEnvelope } from "./ffi.ts";

export interface ReceivedItem {
  // One td_receive result, still unparsed
  raw: string;
  // Wall-clock time in µs at which it left td_receive
  receivedAt: number;
}

export interface ReceiveLoopConfig {
  // Upper bound on how long one td_receive blocks, so stop requests are noticed
  receiveTimeoutSec: number;
  // Strings collected before a batch is posted
  maxBatch: number;
}

export interface WorkerInit extends ReceiveLoopConfig {
  libraryPath: string;
  // One Int32 slot: 0 while running, 1 to leave the receive loop
  stop: SharedArrayBuffer;
}

export type WorkerMessage =
  | { type: "ready" }
  | { type: "batch"; items: ReceivedItem[] }
  // The loop has exited and will not call td_receive again
  | { type: "stopped" }
  | { type: "fatal"; message: string; stack: string | undefined };

export interface ReceiveLoopDeps {
  // td_receive, with the returned string already copied out of TDLib's buffer
  receive(timeoutSec: number): string | null;
  post(message: WorkerMessage): void;
  nowUs(): number;
}

export interface ClientSink {
  // Every update for this client, in TDLib order
  deliver(update: td.Update, receivedAt: number): void;
  // The hub dropped the client without TDLib closing it (hub stopped or receive worker failed)
  detached(reason: string): void;
}

export interface TdHubOptions {
  libraryPath: string;
  // TDLib's own log, 0 (fatal) to 5 (verbose), written to logFile
  logVerbosity: number;
  logFile: string;
  log: Logger;
  // Called when the receive worker fails or exits unexpectedly, or once when a client fails to handle
  // an update. The caller should exit and let the process supervisor restart Robin
  onFatal(error: Error): void;
  loop?: Partial<ReceiveLoopConfig>;
  // Default per-request timeout; 0 disables it
  requestTimeoutMs?: number;
  // Worker script override, for tests
  workerUrl?: string | URL;
}

export interface SendOptions {
  timeoutMs?: number;
}

export interface TdHubStats {
  pending: number;
  clients: number;
  // TDLib instances not yet reported closed, with or without a client attached
  instances: number;
}

export interface TdHub {
  readonly stats: TdHubStats;
  // A new TDLib instance; it stays silent until the first request is sent to it
  registerClient(sink: ClientSink): number;
  // Called once the client reported authorizationStateClosed; TDLib has destroyed the instance
  unregisterClient(clientId: number, reason: string): void;
  send<R extends td.Request>(clientId: number, request: R, options?: SendOptions): Promise<td.ResultOf<R>>;
  // Synchronous TDLib call; throws TdError when TDLib answers with an error
  execute<R extends td.Request>(request: R): td.ResultOf<R>;
  // Clients should be closed first: their sinks are detached here, so their final updates are lost.
  // Instances still open are closed before receiving stops (see closeOpenInstances)
  stop(): Promise<void>;
}

interface Pending {
  clientId: number;
  method: string;
  resolve(result: TdEnvelope): void;
  reject(error: Error): void;
  timer?: Timer;
}

const DEFAULT_LOOP: ReceiveLoopConfig = { receiveTimeoutSec: 1, maxBatch: 256 };
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const INSTANCE_CLOSE_TIMEOUT_MS = 15_000;
const WORKER_URL = new URL(import.meta.url);

// td_receive must have a single owner per process; released only once the worker has left its loop
let hubOpen = false;

// Kept free of FFI and Worker globals so it can be tested in-process.
// Runs until the stop flag is set; throws only on bugs, which fail the worker
export function runReceiveLoop(stop: Int32Array, config: ReceiveLoopConfig, deps: ReceiveLoopDeps): void {
  while (Atomics.load(stop, 0) === 0) {
    const items: ReceivedItem[] = [];
    // Block for the first item, then drain whatever is already queued without waiting
    let timeout = config.receiveTimeoutSec;
    while (items.length < config.maxBatch) {
      const result = deps.receive(timeout);
      if (result === null) break;
      items.push({ raw: result, receivedAt: deps.nowUs() });
      timeout = 0;
    }
    if (items.length > 0) deps.post({ type: "batch", items });
  }
  deps.post({ type: "stopped" });
}

// Worker entry point: loads libtdjson, runs the receive loop and posts batches to the main thread.
// Data flows one way; the main thread calls td_send / td_execute directly (both are thread-safe)
declare const self: Worker;
if (!Bun.isMainThread) {
  const post = (message: WorkerMessage) => self.postMessage(message);
  self.onmessage = (event: MessageEvent<WorkerInit>) => {
    const init = event.data;
    try {
      const { symbols } = dlopen(init.libraryPath, {
        td_receive: { args: [FFIType.f64], returns: FFIType.ptr },
      });
      post({ type: "ready" });
      runReceiveLoop(new Int32Array(init.stop), init, {
        receive: (timeout) => readCString(symbols.td_receive(timeout)),
        post,
        nowUs: () => Math.floor((performance.timeOrigin + performance.now()) * 1000),
      });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      post({ type: "fatal", message: e.message, stack: e.stack });
      throw e;
    }
  };
}

// Recovery: the single receive worker is never replaced in-process; if it fails or exits unexpectedly,
// the hub reports through onFatal so the process exits and its supervisor restarts it. A client failing
// to handle an update is reported too, while receiving goes on so shutdown can close every account.
// Exit: TDLib aborts the process (SIGABRT from one of its threads while exit() runs static destructors)
// when an instance is still open, so stop() closes leftovers while it can still receive their
// authorizationStateClosed. Only a dead receive worker leaves them open
export function createTdHub(options: TdHubOptions): TdHub {
  if (hubOpen) throw new Error("A TdHub is already open: td_receive must have a single owner per process");
  hubOpen = true;

  const { log } = options;
  const loop: ReceiveLoopConfig = { ...DEFAULT_LOOP, ...options.loop };
  const stopFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const clients = new Map<number, ClientSink>();
  // Outlives the sink: a detached client's TDLib instance is open until TDLib says otherwise
  const instances = new Set<number>();
  let onInstancesClosed: (() => void) | undefined;
  const pending = new Map<string, Pending>();
  let nextExtra = 0;
  let stopping: Promise<void> | undefined;
  let stopRequested = false;
  // Receiving is gone for good
  let failed = false;
  let deliveryFailed = false;

  let tdjson: ReturnType<typeof openTdJson>;
  try {
    tdjson = openTdJson(options.libraryPath);
    // Before any client exists, so TDLib never writes to stderr
    execute({ "@type": "setLogVerbosityLevel", new_verbosity_level: options.logVerbosity });
    execute({
      "@type": "setLogStream",
      log_stream: {
        "@type": "logStreamFile",
        path: options.logFile,
        max_file_size: 50 * 1024 * 1024,
        redirect_stderr: false,
      },
    });
  } catch (error) {
    hubOpen = false;
    throw error;
  }

  // terminate() does not interrupt a thread blocked in td_receive: it keeps looping in native code.
  // So stop() sets stopFlag and waits for the worker to leave its loop before terminating it
  const worker = new Worker(options.workerUrl ?? WORKER_URL);
  const { promise: workerStopped, resolve: markWorkerStopped } = Promise.withResolvers<void>();

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => onWorkerMessage(event.data);
  worker.addEventListener("error", (event) => {
    log.error("Receive worker threw: {message}", { message: event.message });
  });
  worker.addEventListener("close", (event) => {
    markWorkerStopped();
    if (stopRequested) return;
    fail(new Error(`Receive worker exited unexpectedly with code ${event.code}`));
  });

  const init: WorkerInit = {
    ...loop,
    libraryPath: options.libraryPath,
    stop: stopFlag.buffer as SharedArrayBuffer,
  };
  worker.postMessage(init);

  function execute<R extends td.Request>(request: R): td.ResultOf<R> {
    const result = tdjson.execute(request);
    if (result === null) throw new TdError(0, "no result", request["@type"]);
    if (result["@type"] === "error") throw toTdError(result as td.error, request["@type"]);
    return result as unknown as td.ResultOf<R>;
  }

  function registerClient(sink: ClientSink): number {
    if (stopRequested) throw new TdClosedError("TDLib is stopping");
    const clientId = tdjson.createClientId();
    clients.set(clientId, sink);
    instances.add(clientId);
    return clientId;
  }

  function unregisterClient(clientId: number, reason: string): void {
    if (!clients.delete(clientId)) return;
    failPending(clientId, new TdClosedError(`Client ${clientId} closed: ${reason}`));
  }

  function send<R extends td.Request>(
    clientId: number,
    request: R,
    { timeoutMs }: SendOptions = {},
  ): Promise<td.ResultOf<R>> {
    const method = request["@type"];
    if (stopRequested) {
      return Promise.reject(new TdClosedError(`Cannot send ${method}: TDLib is stopping`));
    }
    if (!clients.has(clientId)) {
      return Promise.reject(new TdClosedError(`Cannot send ${method}: client ${clientId} is closed`));
    }
    return sendUnchecked(
      clientId,
      request,
      timeoutMs ?? options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  // send() without the open checks, so stop() can still reach detached instances
  function sendUnchecked<R extends td.Request>(
    clientId: number,
    request: R,
    timeout: number,
  ): Promise<td.ResultOf<R>> {
    const method = request["@type"];
    const extra = String(++nextExtra);
    return new Promise<td.ResultOf<R>>((resolve, reject) => {
      // TDLib answers a request R with ResultOf<R> or an error, which dispatch() has already split off
      const entry: Pending = {
        clientId,
        method,
        resolve: (r) => resolve(r as unknown as td.ResultOf<R>),
        reject,
      };
      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          pending.delete(extra);
          reject(new TdTimeoutError(method, timeout));
        }, timeout);
      }
      pending.set(extra, entry);
      try {
        tdjson.send(clientId, { ...request, "@extra": extra });
      } catch (error) {
        settle(extra);
        reject(error);
      }
    });
  }

  function stop(): Promise<void> {
    stopRequested = true;
    stopping ??= shutdown();
    return stopping;
  }

  async function shutdown(): Promise<void> {
    if (clients.size > 0) {
      log.warn("Stopping TDLib with {count} clients still open", { count: clients.size });
    }
    detachClients("TDLib stopped");

    if (!failed) await closeOpenInstances();
    // Setting the stop flag makes the loop exit after its current td_receive returns
    Atomics.store(stopFlag, 0, 1);
    const graceMs = loop.receiveTimeoutSec * 1000 + 5_000;
    const stopped = await Promise.race([
      workerStopped.then(() => true),
      Bun.sleep(graceMs).then(() => false),
    ]);
    // hubOpen stays set: the stuck thread may still call td_receive, so no new hub may start
    if (!stopped) throw new Error(`Receive worker did not stop within ${graceMs} ms`);
    worker.terminate();
    hubOpen = false;
  }

  // Normally empty: accounts close their clients before the hub stops. Whatever is left (a close that
  // timed out, a client never closed) is closed here, while the worker still receives the answer
  async function closeOpenInstances(): Promise<void> {
    if (instances.size === 0) return;
    log.warn("Closing {count} TDLib instances left open", { count: instances.size });
    const { promise: allClosed, resolve } = Promise.withResolvers<void>();
    onInstancesClosed = resolve;
    for (const clientId of instances) {
      // The instance reports authorizationStateClosed either way; an error here only means it was closing
      sendUnchecked(clientId, { "@type": "close" }, 0).catch((error: unknown) =>
        log.debug("close for TDLib instance {clientId} failed", { clientId, error }),
      );
    }
    await Promise.race([allClosed, Bun.sleep(INSTANCE_CLOSE_TIMEOUT_MS)]);
    onInstancesClosed = undefined;
    if (instances.size > 0) {
      log.error("{count} TDLib instances did not close; TDLib may abort on exit", { count: instances.size });
    }
  }

  function onWorkerMessage(message: WorkerMessage): void {
    switch (message.type) {
      case "batch":
        deliverBatch(message.items);
        return;
      case "ready":
        log.debug("Receive worker ready");
        return;
      case "stopped":
        markWorkerStopped();
        return;
      case "fatal":
        log.error("Receive worker failed: {message}", { message: message.message, stack: message.stack });
        fail(new Error(`Receive worker failed: ${message.message}`));
        return;
    }
  }

  // A batch has left TDLib for good, so one failing message must not take the rest of it down:
  // the first failure goes to onFatal, later ones are only logged, and delivery carries on.
  // Receiving carries on too: the shutdown that onFatal starts closes the accounts through this hub,
  // and TDLib must still be heard closing them (see closeOpenInstances)
  function deliverBatch(items: ReceivedItem[]): void {
    for (const { raw, receivedAt } of items) {
      try {
        dispatch(raw, receivedAt);
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        if (deliveryFailed) {
          log.error("Failed to deliver a TDLib message after a fatal error", { error: cause });
          continue;
        }
        deliveryFailed = true;
        options.onFatal(new Error(`Failed to deliver a TDLib message: ${cause.message}`, { cause }));
      }
    }
  }

  function dispatch(raw: string, receivedAt: number): void {
    // Routing fields are stripped, so clients see exactly the td_api.tl object
    const { "@extra": extra, "@client_id": clientId, ...object } = parseTdJson(raw);

    if (extra !== undefined) {
      const entry = settle(extra);
      // A response that arrives after its request timed out or its client closed
      if (!entry) {
        log.warn("Response to unknown request {extra} ({type})", { extra, type: object["@type"] });
      } else if (object["@type"] === "error") {
        entry.reject(toTdError(object as td.error, entry.method));
      } else {
        entry.resolve(object);
      }
      return;
    }

    if (clientId === undefined) throw new Error(`TDLib sent ${object["@type"]} without @client_id`);
    // Without @extra, TDLib only ever sends updates
    const update = object as td.Update;
    if (
      update["@type"] === "updateAuthorizationState" &&
      update.authorization_state["@type"] === "authorizationStateClosed"
    ) {
      instances.delete(clientId);
      if (instances.size === 0) onInstancesClosed?.();
    }
    // Updates still queued for a client that has already been unregistered
    const sink = clients.get(clientId);
    if (!sink) {
      log.debug("Message {type} for unknown client {clientId}", { type: update["@type"], clientId });
      return;
    }
    sink.deliver(update, receivedAt);
  }

  function settle(extra: string): Pending | undefined {
    const entry = pending.get(extra);
    if (!entry) return undefined;
    pending.delete(extra);
    clearTimeout(entry.timer);
    return entry;
  }

  function failPending(clientId: number, error: Error): void {
    for (const [extra, entry] of pending) {
      if (entry.clientId !== clientId) continue;
      settle(extra);
      entry.reject(error);
    }
  }

  // Receiving is gone for good. Nothing answers the clients after that, so they are detached instead of
  // left to time out in close(); their TDLib instances cannot be closed any more
  function fail(error: Error): void {
    if (failed) return;
    failed = true;
    onInstancesClosed?.();
    detachClients("TDLib receive worker failed");
    options.onFatal(error);
  }

  function detachClients(reason: string): void {
    for (const [clientId, sink] of [...clients]) {
      unregisterClient(clientId, reason);
      sink.detached(reason);
    }
  }

  return {
    get stats() {
      return {
        pending: pending.size,
        clients: clients.size,
        instances: instances.size,
      };
    },
    registerClient,
    unregisterClient,
    send,
    execute,
    stop,
  };
}

function toTdError(error: td.error, method: string): TdError {
  return new TdError(error.code, error.message, method);
}
