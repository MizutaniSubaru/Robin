// Real receive worker that throws right after posting a batch while the marker file exists.
// The marker is removed before throwing, so only one generation crashes
import { dlopen, FFIType } from "bun:ffi";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCString } from "../../src/sources/tdlib/ffi.ts";
import type { WorkerInit, WorkerMessage } from "../../src/sources/tdlib/protocol.ts";
import { runReceiveLoop } from "../../src/sources/tdlib/receive-loop.ts";

declare const self: Worker;

// Same path as crashMarkerPath() in the test; workers share the process id
const marker = join(tmpdir(), `robin-crash-marker-${process.pid}`);

self.onmessage = (event: MessageEvent<WorkerInit>) => {
  const init = event.data;
  const { symbols } = dlopen(init.libraryPath, { td_receive: { args: [FFIType.f64], returns: FFIType.ptr } });
  runReceiveLoop(new Int32Array(init.ctrl), init.generation, init, {
    receive: (timeout) => readCString(symbols.td_receive(timeout)),
    post(message: WorkerMessage) {
      self.postMessage(message);
      if (message.type === "batch" && Bun.file(marker).size > 0) {
        rmSync(marker);
        throw new Error("injected crash");
      }
    },
    nowUs: () => Date.now() * 1000,
  });
};
