// Worker entry: owns td_receive. Started and supervised by the hub
import { dlopen, FFIType } from "bun:ffi";

import { readCString } from "./ffi.ts";
import type { WorkerInit, WorkerMessage } from "./protocol.ts";
import { runReceiveLoop } from "./receive-loop.ts";

declare const self: Worker;

const post = (message: WorkerMessage) => self.postMessage(message);

self.onmessage = (event: MessageEvent<WorkerInit>) => {
  const init = event.data;
  try {
    const { symbols } = dlopen(init.libraryPath, {
      td_receive: { args: [FFIType.f64], returns: FFIType.ptr },
    });
    post({ type: "ready", generation: init.generation });
    runReceiveLoop(new Int32Array(init.ctrl), init.generation, init, {
      receive: (timeout) => readCString(symbols.td_receive(timeout)),
      post,
      nowUs: () => Math.floor((performance.timeOrigin + performance.now()) * 1000),
    });
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    post({ type: "fatal", generation: init.generation, message: e.message, stack: e.stack });
    // Rethrow so the worker closes with an error and the hub restarts it
    throw e;
  }
};
