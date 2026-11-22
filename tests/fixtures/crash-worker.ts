// Receive worker fixture that immediately fails, for testing the hub's fatal path
import type { WorkerInit, WorkerMessage } from "../../src/sources/tdlib/hub.ts";

declare const self: Worker;

self.onmessage = (_event: MessageEvent<WorkerInit>) => {
  const message: WorkerMessage = { type: "fatal", message: "injected crash", stack: undefined };
  self.postMessage(message);
  throw new Error("injected crash");
};
