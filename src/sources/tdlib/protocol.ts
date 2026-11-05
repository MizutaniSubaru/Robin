// Contract between the main thread and the receive worker.
//
// Data flows one way: the worker owns td_receive and posts batches of raw JSON strings to the main thread.
// The main thread calls td_send / td_execute itself (both are thread-safe), so requests never wait on the worker.
// Control flows through a SharedArrayBuffer, which the worker can read while blocked in its loop.

// Int32 slots of the control block
export const Ctrl = {
  // Generation allowed to receive; anything else (0 included) tells a worker to leave its loop
  OWNER: 0,
  // Generation currently inside td_receive, 0 when none. TDLib aborts the process
  // if td_receive runs on two threads at once, so this is a mutex, not just a flag
  RECEIVING: 1,
  // Batches posted but not yet processed by the main thread, for backpressure
  IN_FLIGHT: 2,
  // Bumped on every loop iteration, read by the main thread's watchdog
  HEARTBEAT: 3,
} as const;

export const CTRL_SLOTS = 4;

export interface ReceiveLoopConfig {
  // Upper bound on how long one td_receive blocks, so stop requests are noticed
  receiveTimeoutSec: number;
  // Strings collected before a batch is posted
  maxBatch: number;
  // Batches the main thread may have queued before the worker stops receiving
  maxInFlight: number;
}

export interface WorkerInit extends ReceiveLoopConfig {
  libraryPath: string;
  ctrl: SharedArrayBuffer;
  generation: number;
}

export type WorkerMessage =
  | { type: "ready"; generation: number }
  // receivedAt[i] is the wall-clock time in µs at which items[i] left td_receive
  | { type: "batch"; generation: number; items: string[]; receivedAt: number[] }
  // The loop has exited and will not call td_receive again
  | { type: "stopped"; generation: number }
  | { type: "fatal"; generation: number; message: string; stack?: string };
