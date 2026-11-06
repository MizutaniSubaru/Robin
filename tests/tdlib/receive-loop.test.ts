import { afterEach, describe, expect, test } from "bun:test";

import { CTRL_SLOTS, Ctrl, type WorkerMessage } from "../../src/sources/tdlib/protocol.ts";
import { runReceiveLoop } from "../../src/sources/tdlib/receive-loop.ts";
import type { FakeInit } from "../fixtures/fake-receive-worker.ts";

const FAKE_WORKER = new URL("../fixtures/fake-receive-worker.ts", import.meta.url);

function newCtrl(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(CTRL_SLOTS * 4));
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(10);
  }
}

describe("runReceiveLoop in-process", () => {
  test("drains queued items into one batch and exits when ownership is revoked", () => {
    const ctrl = newCtrl();
    Atomics.store(ctrl, Ctrl.OWNER, 7);
    const queue = ["a", "b", "c"];
    const timeouts: number[] = [];
    const posted: WorkerMessage[] = [];

    runReceiveLoop(
      ctrl,
      7,
      { receiveTimeoutSec: 1, maxBatch: 10, maxInFlight: 10 },
      {
        receive(timeout) {
          timeouts.push(timeout);
          const next = queue.shift();
          if (next === undefined) Atomics.store(ctrl, Ctrl.OWNER, 0);
          return next ?? null;
        },
        post: (message) => posted.push(message),
        nowUs: () => 1,
      },
    );

    // Only the first call of a batch blocks
    expect(timeouts).toEqual([1, 0, 0, 0]);
    expect(posted).toEqual([
      {
        type: "batch",
        generation: 7,
        items: [
          { raw: "a", receivedAt: 1 },
          { raw: "b", receivedAt: 1 },
          { raw: "c", receivedAt: 1 },
        ],
      },
      { type: "stopped", generation: 7 },
    ]);
    expect(Atomics.load(ctrl, Ctrl.IN_FLIGHT)).toBe(1);
    expect(Atomics.load(ctrl, Ctrl.RECEIVING)).toBe(0);
  });

  test("splits batches at maxBatch", () => {
    const ctrl = newCtrl();
    Atomics.store(ctrl, Ctrl.OWNER, 1);
    let n = 0;
    const batches: string[][] = [];
    runReceiveLoop(
      ctrl,
      1,
      { receiveTimeoutSec: 1, maxBatch: 2, maxInFlight: 10 },
      {
        receive() {
          if (n === 5) {
            Atomics.store(ctrl, Ctrl.OWNER, 0);
            return null;
          }
          return String(n++);
        },
        post: (message) => {
          if (message.type === "batch") batches.push(message.items.map((item) => item.raw));
        },
        nowUs: () => 0,
      },
    );
    expect(batches).toEqual([["0", "1"], ["2", "3"], ["4"]]);
  });

  test("an exception from receive releases the mutex", () => {
    const ctrl = newCtrl();
    Atomics.store(ctrl, Ctrl.OWNER, 3);
    expect(() =>
      runReceiveLoop(
        ctrl,
        3,
        { receiveTimeoutSec: 1, maxBatch: 10, maxInFlight: 10 },
        {
          receive() {
            throw new Error("boom");
          },
          post: () => {},
          nowUs: () => 0,
        },
      ),
    ).toThrow("boom");
    expect(Atomics.load(ctrl, Ctrl.RECEIVING)).toBe(0);
  });
});

describe("runReceiveLoop across threads", () => {
  let worker: Worker | undefined;
  afterEach(() => worker?.terminate());

  function start(ctrl: Int32Array, maxInFlight: number) {
    const stats = new SharedArrayBuffer(4);
    const messages: WorkerMessage[] = [];
    worker = new Worker(FAKE_WORKER);
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => messages.push(event.data);
    const init: FakeInit = {
      ctrl: ctrl.buffer as SharedArrayBuffer,
      stats,
      generation: 5,
      config: { receiveTimeoutSec: 0.05, maxBatch: 100, maxInFlight },
    };
    worker.postMessage(init);
    return { messages, calls: new Int32Array(stats) };
  }

  test("stops receiving while maxInFlight batches are unprocessed", async () => {
    const ctrl = newCtrl();
    Atomics.store(ctrl, Ctrl.OWNER, 5);
    const { messages, calls } = start(ctrl, 2);

    await waitFor(() => messages.length === 2);
    const callsWhenFull = Atomics.load(calls, 0);
    await Bun.sleep(300);
    // Full: no more td_receive calls and no more batches
    expect(Atomics.load(calls, 0)).toBe(callsWhenFull);
    expect(messages).toHaveLength(2);
    expect(Atomics.load(ctrl, Ctrl.IN_FLIGHT)).toBe(2);

    // Acknowledge one batch, the worker resumes
    Atomics.sub(ctrl, Ctrl.IN_FLIGHT, 1);
    Atomics.notify(ctrl, Ctrl.IN_FLIGHT);
    await waitFor(() => messages.length === 3);

    Atomics.store(ctrl, Ctrl.OWNER, 0);
    Atomics.store(ctrl, Ctrl.IN_FLIGHT, 0);
    Atomics.notify(ctrl, Ctrl.IN_FLIGHT);
    await waitFor(() => messages.at(-1)?.type === "stopped");
  });

  test("never calls receive while another generation holds the mutex", async () => {
    const ctrl = newCtrl();
    Atomics.store(ctrl, Ctrl.OWNER, 5);
    // A stale receiver from generation 4 is still inside td_receive
    Atomics.store(ctrl, Ctrl.RECEIVING, 4);
    const { messages, calls } = start(ctrl, 10);

    await Bun.sleep(400);
    expect(Atomics.load(calls, 0)).toBe(0);
    // Still looping, not stuck
    expect(Atomics.load(ctrl, Ctrl.HEARTBEAT)).toBeGreaterThan(0);

    Atomics.store(ctrl, Ctrl.RECEIVING, 0);
    Atomics.notify(ctrl, Ctrl.RECEIVING);
    await waitFor(() => messages.some((m) => m.type === "batch"));
    expect(Atomics.load(calls, 0)).toBeGreaterThan(0);

    Atomics.store(ctrl, Ctrl.OWNER, 0);
    await waitFor(() => messages.at(-1)?.type === "stopped");
  });
});
