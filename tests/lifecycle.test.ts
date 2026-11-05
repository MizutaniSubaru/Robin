import { describe, expect, test } from "bun:test";

import { createLifecycle } from "../src/lifecycle.ts";

describe("lifecycle", () => {
  test("runs cleanups in reverse registration order", async () => {
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

  test("keeps running other cleanups when one throws", async () => {
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

  test("concurrent stop calls run cleanups only once", async () => {
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

  test("defer after stop throws", async () => {
    const lc = createLifecycle(() => {});
    await lc.stop();
    expect(() => lc.defer("late", () => {})).toThrow(/shutting down/);
  });
});
