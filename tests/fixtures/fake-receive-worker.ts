// Runs the receive loop against a fake td_receive that counts its calls in `stats`
import type { ReceiveLoopConfig } from "../../src/sources/tdlib/protocol.ts";
import { runReceiveLoop } from "../../src/sources/tdlib/receive-loop.ts";

declare const self: Worker;

export interface FakeInit {
  ctrl: SharedArrayBuffer;
  stats: SharedArrayBuffer;
  generation: number;
  config: ReceiveLoopConfig;
}

self.onmessage = (event: MessageEvent<FakeInit>) => {
  const { ctrl, stats, generation, config } = event.data;
  const calls = new Int32Array(stats);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  runReceiveLoop(new Int32Array(ctrl), generation, config, {
    receive(timeout) {
      const n = Atomics.add(calls, 0, 1);
      // Every third call times out, like an idle td_receive
      if (n % 3 === 2) {
        Atomics.wait(sleeper, 0, 0, timeout * 1000);
        return null;
      }
      return `item-${n}`;
    },
    post: (message) => self.postMessage(message),
    nowUs: () => Date.now() * 1000,
  });
};
