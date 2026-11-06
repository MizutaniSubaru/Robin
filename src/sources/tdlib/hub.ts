import type { Logger } from "../../log/index.ts";
import type * as td from "../../tdlib-api/td-api.ts";
import { TdClosedError, TdError, TdTimeoutError } from "./errors.ts";
import { openTdJson, parseTdJson, type TdEnvelope } from "./ffi.ts";
import {
  CTRL_SLOTS,
  Ctrl,
  type ReceivedItem,
  type ReceiveLoopConfig,
  type WorkerInit,
  type WorkerMessage,
} from "./protocol.ts";

export interface ClientSink {
  // Every update for this client, in TDLib order
  deliver(update: td.Update, receivedAt: number): void;
  // The hub dropped the client without TDLib closing it (hub stopped)
  detached(reason: string): void;
}

export interface TdHubOptions {
  libraryPath: string;
  // TDLib's own log, 0 (fatal) to 5 (verbose), written to logFile
  logVerbosity: number;
  logFile: string;
  log: Logger;
  // Called once when receiving cannot go on (stalled inside TDLib, crash loop, a client failed to
  // handle an update). The caller should exit and let the process supervisor restart Robin
  onFatal(error: Error): void;
  loop?: Partial<ReceiveLoopConfig>;
  // Default per-request timeout; 0 disables it
  requestTimeoutMs?: number;
  // No heartbeat for this long means td_receive is stuck
  stallTimeoutMs?: number;
  // Worker script override, for tests
  workerUrl?: string | URL;
}

export interface SendOptions {
  timeoutMs?: number;
}

export interface TdHubStats {
  generation: number;
  restarts: number;
  pending: number;
  clients: number;
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
  // Clients should be closed first: once receiving stops, their final updates are lost
  stop(): Promise<void>;
}

interface Pending {
  clientId: number;
  method: string;
  resolve(result: TdEnvelope): void;
  reject(error: Error): void;
  timer?: Timer;
}

interface WorkerHandle {
  generation: number;
  worker: Worker;
  // The loop has exited (graceful stop) or the thread is gone (crash)
  stopped: Promise<void>;
  markStopped(): void;
}

const DEFAULT_LOOP: ReceiveLoopConfig = { receiveTimeoutSec: 1, maxBatch: 256, maxInFlight: 64 };
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const RESTART_BASE_MS = 200;
const RESTART_MAX_MS = 30_000;
const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_CRASHES_IN_WINDOW = 5;
const WORKER_URL = new URL("./receive-worker.ts", import.meta.url);

// td_receive is process-wide, so the control block (and its RECEIVING mutex) is too,
// and generations never repeat across hubs
const ctrl = new Int32Array(new SharedArrayBuffer(CTRL_SLOTS * Int32Array.BYTES_PER_ELEMENT));
let lastGeneration = 0;
// Released only once the hub's worker has left its loop
let hubOpen = false;

// One per process: owns libtdjson, the receive worker and request routing for every client.
//
// Threads: the worker only calls td_receive and posts raw strings; this thread parses them,
// resolves requests by @extra and hands updates to clients by @client_id.
// Recovery: a crashed worker is replaced once its thread is gone (TDLib keeps queuing meanwhile);
// a worker stuck inside td_receive cannot be replaced safely, so that is reported through onFatal.
// At most one hub per process
export function createTdHub(options: TdHubOptions): TdHub {
  if (hubOpen) throw new Error("A TdHub is already open: td_receive must have a single owner per process");
  hubOpen = true;

  const { log } = options;
  const loop: ReceiveLoopConfig = { ...DEFAULT_LOOP, ...options.loop };
  const clients = new Map<number, ClientSink>();
  const pending = new Map<string, Pending>();
  let crashes: number[] = [];
  let current: WorkerHandle | undefined;
  let generation = 0;
  let restarts = 0;
  let nextExtra = 0;
  let lastHeartbeat = -1;
  let lastHeartbeatAt = Date.now();
  let restartTimer: Timer | undefined;
  let stopping: Promise<void> | undefined;
  let stopRequested = false;
  let failed = false;

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

  spawn();
  const watchdog = setInterval(checkHeartbeat, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

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

    const extra = String(++nextExtra);
    const timeout = timeoutMs ?? options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
    clearInterval(watchdog);
    clearTimeout(restartTimer);
    if (clients.size > 0) {
      log.warn("Stopping TDLib with {count} clients still open", { count: clients.size });
    }
    detachClients("TDLib stopped");

    const handle = current;
    if (!handle) {
      hubOpen = false;
      return;
    }
    // Revoking ownership makes the loop exit after its current td_receive returns
    Atomics.store(ctrl, Ctrl.OWNER, 0);
    Atomics.notify(ctrl, Ctrl.IN_FLIGHT);
    const graceMs = loop.receiveTimeoutSec * 1000 + 5_000;
    const stopped = await Promise.race([
      handle.stopped.then(() => true),
      Bun.sleep(graceMs).then(() => false),
    ]);
    current = undefined;
    // hubOpen stays set: the stuck thread may still call td_receive, so no new hub may start
    if (!stopped) throw new Error(`Receive worker did not stop within ${graceMs} ms`);
    // Safe now: the thread is out of td_receive. Never terminate it earlier, see spawn()
    handle.worker.terminate();
    hubOpen = false;
  }

  function spawn(): void {
    generation = ++lastGeneration;
    const handleGeneration = generation;
    // Batches still queued from a dead generation no longer count against the new one
    Atomics.store(ctrl, Ctrl.IN_FLIGHT, 0);
    Atomics.store(ctrl, Ctrl.OWNER, handleGeneration);
    lastHeartbeatAt = Date.now();

    // terminate() does not interrupt a thread blocked in td_receive: it keeps looping in native code,
    // and a second receiver makes TDLib abort the process. So a worker is only ever replaced after
    // it has left its loop on its own, and the RECEIVING mutex guards against mistakes here
    const worker = new Worker(options.workerUrl ?? WORKER_URL);
    const { promise: stopped, resolve: markStopped } = Promise.withResolvers<void>();
    const handle: WorkerHandle = { generation: handleGeneration, worker, stopped, markStopped };
    current = handle;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => onWorkerMessage(handle, event.data);
    worker.addEventListener("error", (event) => {
      log.error("Receive worker {generation} threw: {message}", {
        generation: handleGeneration,
        message: event.message,
      });
    });
    worker.addEventListener("close", (event) => onWorkerClose(handle, event.code));

    const init: WorkerInit = {
      ...loop,
      libraryPath: options.libraryPath,
      ctrl: ctrl.buffer as SharedArrayBuffer,
      generation: handleGeneration,
    };
    worker.postMessage(init);
  }

  function onWorkerMessage(handle: WorkerHandle, message: WorkerMessage): void {
    switch (message.type) {
      case "batch":
        try {
          deliverBatch(message.items);
        } finally {
          if (handle === current) {
            Atomics.sub(ctrl, Ctrl.IN_FLIGHT, 1);
            Atomics.notify(ctrl, Ctrl.IN_FLIGHT);
          }
        }
        return;
      case "ready":
        log.debug("Receive worker {generation} ready", { generation: message.generation });
        return;
      case "stopped":
        handle.markStopped();
        // Posted after the worker's last batch, so everything it took from TDLib has been delivered
        if (failed && handle === current) detachClients("TDLib receive loop stopped");
        return;
      case "fatal":
        log.error("Receive worker {generation} failed: {message}", {
          generation: message.generation,
          message: message.message,
          stack: message.stack,
        });
        return;
    }
  }

  function onWorkerClose(handle: WorkerHandle, code: number): void {
    handle.markStopped();
    if (handle !== current || stopRequested) return;
    current = undefined;

    // A crash unwinds the JS stack, so the thread cannot still be inside td_receive
    if (Atomics.load(ctrl, Ctrl.RECEIVING) !== 0) {
      fail(new Error("Receive worker exited while holding the td_receive mutex"), false);
      return;
    }

    const now = Date.now();
    crashes = [...crashes.filter((at) => at >= now - CRASH_WINDOW_MS), now];
    if (crashes.length > MAX_CRASHES_IN_WINDOW) {
      fail(new Error(`Receive worker crashed ${crashes.length} times in ${CRASH_WINDOW_MS / 1000} s`), false);
      return;
    }

    const delayMs = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (crashes.length - 1));
    log.error("Receive worker {generation} exited with code {code}, restarting in {delayMs} ms", {
      generation: handle.generation,
      code,
      delayMs,
    });
    restartTimer = setTimeout(() => {
      if (stopRequested || failed) return;
      restarts++;
      spawn();
    }, delayMs);
  }

  // A batch has left TDLib for good, so one failing message must not take the rest of it down:
  // the first failure goes to onFatal, later ones are only logged, and delivery carries on
  function deliverBatch(items: ReceivedItem[]): void {
    for (const { raw, receivedAt } of items) {
      try {
        dispatch(raw, receivedAt);
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        if (failed) log.error("Failed to deliver a TDLib message after a fatal error", { error: cause });
        else fail(new Error(`Failed to deliver a TDLib message: ${cause.message}`, { cause }), true);
      }
    }
  }

  function dispatch(raw: string, receivedAt: number): void {
    // Routing fields are stripped, so clients and storage see exactly the td_api.tl object
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
    // Updates still queued for a client that has already been unregistered
    const sink = clients.get(clientId);
    if (!sink) {
      log.debug("Message {type} for unknown client {clientId}", { type: object["@type"], clientId });
      return;
    }
    // Without @extra, TDLib only ever sends updates
    sink.deliver(object as td.Update, receivedAt);
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

  function checkHeartbeat(): void {
    if (!current || stopRequested || failed) return;
    const heartbeat = Atomics.load(ctrl, Ctrl.HEARTBEAT);
    const now = Date.now();
    if (heartbeat !== lastHeartbeat) {
      lastHeartbeat = heartbeat;
      lastHeartbeatAt = now;
      return;
    }
    const stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    if (now - lastHeartbeatAt > stallMs) {
      const receiving = Atomics.load(ctrl, Ctrl.RECEIVING);
      fail(
        new Error(
          `TDLib receive loop stalled for ${now - lastHeartbeatAt} ms` +
            (receiving ? " inside td_receive" : ""),
        ),
        false,
      );
    }
  }

  // Stops receiving for good. Nothing answers the clients after that, so they are detached instead of
  // left to time out in close(). With drain, the worker is healthy: it leaves its loop after the
  // current td_receive, and clients are detached once it has handed over everything it took from TDLib
  function fail(error: Error, drain: boolean): void {
    if (failed) return;
    failed = true;
    if (drain && current) {
      Atomics.store(ctrl, Ctrl.OWNER, 0);
      Atomics.notify(ctrl, Ctrl.IN_FLIGHT);
    } else {
      detachClients("TDLib receive loop failed");
    }
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
      return { generation, restarts, pending: pending.size, clients: clients.size };
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
