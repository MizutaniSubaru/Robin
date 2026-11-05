import { describe, expect, test } from "bun:test";

import type { UpdateListener } from "../../src/sources/tdlib/client.ts";
import type { TdObject } from "../../src/sources/tdlib/ffi.ts";
import { createSendTracker } from "../../src/sources/tdlib/send-tracker.ts";

function fakeUpdates() {
  const listeners = new Set<UpdateListener>();
  return {
    onUpdate(listener: UpdateListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(update: TdObject) {
      for (const listener of listeners) listener(update, 0);
    },
    get size() {
      return listeners.size;
    },
  };
}

const succeeded = (tempId: number, finalId: number) => ({
  "@type": "updateMessageSendSucceeded",
  old_message_id: tempId,
  message: { "@type": "message", id: finalId },
});

describe("createSendTracker", () => {
  test("confirmation delivered in the same batch as the sendMessage response is not lost", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);

    // The hub resolves the request, then synchronously dispatches the next item of the batch
    // before the awaiting caller resumes
    const response = new Promise<TdObject>((resolve) => {
      resolve({ "@type": "message", id: 7 });
      updates.emit(succeeded(7, 3 << 20));
    });
    const pending = await response;
    const final = await tracker.wait(Number(pending.id), 1000);
    expect(final.id).toBe(3 << 20);
  });

  test("confirmation arriving later settles the waiter", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);
    const waiting = tracker.wait(8, 1000);
    updates.emit(succeeded(8, 4 << 20));
    expect((await waiting).id).toBe(4 << 20);
  });

  test("send failure rejects with the TDLib message", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);
    const waiting = tracker.wait(9, 1000);
    updates.emit({
      "@type": "updateMessageSendFailed",
      old_message_id: 9,
      message: { "@type": "message", id: 9 },
      error: { "@type": "error", code: 400, message: "CHAT_WRITE_FORBIDDEN" },
    });
    await expect(waiting).rejects.toThrow("CHAT_WRITE_FORBIDDEN");
  });

  test("times out without a confirmation", async () => {
    const tracker = createSendTracker(fakeUpdates().onUpdate);
    await expect(tracker.wait(10, 20)).rejects.toThrow(/No send confirmation/);
  });

  test("dispose unsubscribes and rejects waiters", async () => {
    const updates = fakeUpdates();
    const tracker = createSendTracker(updates.onUpdate);
    const waiting = tracker.wait(11, 1000);
    tracker.dispose();
    expect(updates.size).toBe(0);
    await expect(waiting).rejects.toThrow(/Stopped waiting/);
  });
});
