import { describe, expect, test } from "bun:test";
import { createLifecycle } from "../src/lifecycle.ts";

describe("lifecycle", () => {
  test("清理按注册的逆序执行", async () => {
    const order: string[] = [];
    const lc = createLifecycle(() => {});
    lc.defer("a", () => void order.push("a"));
    lc.defer("b", async () => {
      await Bun.sleep(1);
      order.push("b");
    });
    lc.defer("c", () => void order.push("c"));
    await lc.stop();
    expect(order).toEqual(["c", "b", "a"]);
  });

  test("某个清理抛错，其余照常执行", async () => {
    const order: string[] = [];
    const errors: string[] = [];
    const lc = createLifecycle((name) => errors.push(name));
    lc.defer("a", () => void order.push("a"));
    lc.defer("bad", () => {
      throw new Error("boom");
    });
    lc.defer("c", () => void order.push("c"));
    await lc.stop();
    expect(order).toEqual(["c", "a"]);
    expect(errors).toEqual(["bad"]);
  });

  test("并发调用 stop 只执行一遍", async () => {
    let runs = 0;
    const lc = createLifecycle(() => {});
    lc.defer("a", async () => {
      await Bun.sleep(1);
      runs++;
    });
    await Promise.all([lc.stop(), lc.stop(), lc.stop()]);
    await lc.stop();
    expect(runs).toBe(1);
  });

  test("stop 之后再 defer 会抛错", async () => {
    const lc = createLifecycle(() => {});
    await lc.stop();
    expect(() => lc.defer("late", () => {})).toThrow(/shutting down/);
  });
});
