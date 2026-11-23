import { describe, expect, test } from "bun:test";

import type { UpdateListener } from "../../src/sources/tdlib/account.ts";
import type { td } from "../../src/sources/tdlib/index.ts";
import { createSendTracker } from "../../src/sources/tdlib/send-tracker.ts";
import { update } from "../fixtures/td.ts";

function fakeUpdates() {
  const listeners = new Set<UpdateListener>();
  return {
    onUpdate(listener: UpdateListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value: td.Update) {
      for (const listener of listeners) listener(value, 0);
    },
    get size() {
      return listeners.size;
    },
  };
}

const CHAT = -100;

const succeeded = (tempId: number, finalId: number, chatId = CHAT) =>
  update({
    "@type": "updateMessageSendSucceeded",
    old_message_id: tempId,
    message: { "@type": "message", id: finalId, chat_id: chatId },
  });

describe("createSendTracker", () => {
  test("confirmation delivered in the same batch as the sendMessage response is not lost", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);

    // The hub resolves the request, then synchronously dispatches the next item of the batch
    // before the awaiting caller resumes
    const response = new Promise<{ id: number }>((resolve) => {
      resolve({ id: 7 });
      updates.emit(succeeded(7, 3 << 20));
    });
    const pending = await response;
    const final = await tracker.wait(CHAT, pending.id, { timeoutMs: 1000 });
    expect(final.id).toBe(3 << 20);
  });

  test("confirmation arriving later settles the waiter", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);
    const waiting = tracker.wait(CHAT, 8, { timeoutMs: 1000 });
    updates.emit(succeeded(8, 4 << 20));
    expect((await waiting).id).toBe(4 << 20);
  });

  // Regression: temporary ids are per chat, so the same id in two chats must not cross over
  test("matches confirmations by chat as well as temporary id", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);
    const inA = tracker.wait(-1, 5, { timeoutMs: 1000 });
    const inB = tracker.wait(-2, 5, { timeoutMs: 1000 });
    updates.emit(succeeded(5, 20 << 20, -2));
    updates.emit(succeeded(5, 10 << 20, -1));
    expect((await inA).id).toBe(10 << 20);
    expect((await inB).id).toBe(20 << 20);
  });

  test("send failure rejects with the TDLib message", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);
    const waiting = tracker.wait(CHAT, 9, { timeoutMs: 1000 });
    updates.emit(
      update({
        "@type": "updateMessageSendFailed",
        old_message_id: 9,
        message: { "@type": "message", id: 9, chat_id: CHAT },
        error: { "@type": "error", code: 400, message: "CHAT_WRITE_FORBIDDEN" },
      }),
    );
    await expect(waiting).rejects.toThrow("CHAT_WRITE_FORBIDDEN");
  });

  test("times out without a confirmation", async () => {
    const tracker = createSendTracker(fakeUpdates().onUpdate);
    await expect(tracker.wait(CHAT, 10, { timeoutMs: 20 })).rejects.toThrow(/No send confirmation/);
  });

  // Regression: aborting externally left the waiter registered in the tracker until dispose()
  test("aborting the signal rejects and removes the waiter", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);
    const controller = new AbortController();
    const waiting = tracker.wait(CHAT, 12, { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");

    // Re-waiting on the same key succeeds instead of throwing "Already waiting"
    const second = tracker.wait(CHAT, 12, { timeoutMs: 1000 });
    updates.emit(succeeded(12, 6 << 20));
    expect((await second).id).toBe(6 << 20);
  });

  test("an already-aborted signal rejects without registering a waiter", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    await expect(tracker.wait(CHAT, 13, { signal: controller.signal })).rejects.toThrow("already stopped");

    const waiting = tracker.wait(CHAT, 13, { timeoutMs: 1000 });
    updates.emit(succeeded(13, 7 << 20));
    expect((await waiting).id).toBe(7 << 20);
  });

  test("dispose unsubscribes and rejects waiters", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);
    const waiting = tracker.wait(CHAT, 11, { timeoutMs: 1000 });
    tracker.dispose();
    expect(updates.size).toBe(0);
    await expect(waiting).rejects.toThrow(/Stopped waiting/);
  });
});
