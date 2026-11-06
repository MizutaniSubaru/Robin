import { Ctrl, type ReceivedItem, type ReceiveLoopConfig, type WorkerMessage } from "./protocol.ts";

export interface ReceiveLoopDeps {
  // td_receive, with the returned string already copied out of TDLib's buffer
  receive(timeoutSec: number): string | null;
  post(message: WorkerMessage): void;
  nowUs(): number;
}

// How long to wait before rechecking a full queue or a held receive mutex
const WAIT_MS = 200;

// The receive loop, kept free of FFI and Worker globals so it can be tested in-process.
// Runs until OWNER no longer names this generation; throws only on bugs, which crash the worker
export function runReceiveLoop(
  ctrl: Int32Array,
  generation: number,
  config: ReceiveLoopConfig,
  deps: ReceiveLoopDeps,
): void {
  const isOwner = () => Atomics.load(ctrl, Ctrl.OWNER) === generation;

  while (isOwner()) {
    Atomics.add(ctrl, Ctrl.HEARTBEAT, 1);

    // Backpressure: leave updates queued inside TDLib instead of in our memory
    const inFlight = Atomics.load(ctrl, Ctrl.IN_FLIGHT);
    if (inFlight >= config.maxInFlight) {
      Atomics.wait(ctrl, Ctrl.IN_FLIGHT, inFlight, WAIT_MS);
      continue;
    }

    const items: ReceivedItem[] = [];
    // Block for the first item, then drain whatever is already queued without waiting
    let timeout = config.receiveTimeoutSec;
    while (items.length < config.maxBatch) {
      const result = receiveExclusive(ctrl, generation, timeout, deps);
      if (result === BUSY) {
        // Another generation is still inside td_receive; never call it concurrently
        Atomics.wait(ctrl, Ctrl.RECEIVING, Atomics.load(ctrl, Ctrl.RECEIVING), WAIT_MS);
        break;
      }
      if (result === null) break;
      items.push({ raw: result, receivedAt: deps.nowUs() });
      timeout = 0;
    }

    if (items.length > 0) {
      Atomics.add(ctrl, Ctrl.IN_FLIGHT, 1);
      deps.post({ type: "batch", generation, items });
    }
  }

  deps.post({ type: "stopped", generation });
}

const BUSY = Symbol("busy");

function receiveExclusive(
  ctrl: Int32Array,
  generation: number,
  timeoutSec: number,
  deps: ReceiveLoopDeps,
): string | null | typeof BUSY {
  if (Atomics.compareExchange(ctrl, Ctrl.RECEIVING, 0, generation) !== 0) return BUSY;
  try {
    return deps.receive(timeoutSec);
  } finally {
    Atomics.store(ctrl, Ctrl.RECEIVING, 0);
    Atomics.notify(ctrl, Ctrl.RECEIVING);
  }
}
