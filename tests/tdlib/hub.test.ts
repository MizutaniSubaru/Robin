// Runs against the real libtdjson, offline: test methods and the pre-login authorization states need no network

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLogger } from "../../src/log/index.ts";
import { createTdAccount } from "../../src/sources/tdlib/account.ts";
import { AuthorizationRequiredError } from "../../src/sources/tdlib/auth.ts";
import { TdClosedError, TdError, TdTimeoutError } from "../../src/sources/tdlib/errors.ts";
import { resolveTdjsonPath } from "../../src/sources/tdlib/ffi.ts";
import {
  createTdHub,
  runReceiveLoop,
  type SendOptions,
  type TdHub,
  type TdHubOptions,
  type WorkerMessage,
} from "../../src/sources/tdlib/hub.ts";
import type { td } from "../../src/sources/tdlib/index.ts";

const log = getLogger("test");
const tmp = mkdtempSync(join(tmpdir(), "robin-tdlib-"));
const fatalErrors: Error[] = [];

interface TestClient {
  readonly id: number;
  readonly isOpen: boolean;
  readonly authState: td.AuthorizationState["@type"] | undefined;
  invoke<R extends td.Request>(request: R, options?: SendOptions): Promise<td.ResultOf<R>>;
  onUpdate(fn: (update: td.Update, receivedAt: number) => void): void;
  waitForAuth(): Promise<void>;
  close(): Promise<void>;
}

let hub: TdHub | undefined;
const clients: TestClient[] = [];

function hubOptions(overrides: Partial<TdHubOptions> = {}): TdHubOptions {
  return {
    libraryPath: resolveTdjsonPath(undefined),
    logVerbosity: 1,
    logFile: join(tmp, "tdlib.log"),
    log,
    onFatal: (error) => fatalErrors.push(error),
    loop: { receiveTimeoutSec: 0.2 },
    ...overrides,
  };
}

function openHub(overrides: Partial<TdHubOptions> = {}): TdHub {
  hub = createTdHub(hubOptions(overrides));
  return hub;
}

// Thin ClientSink wrapper for exercising the hub directly against libtdjson
function openClient(h: TdHub): TestClient {
  const listeners: ((update: td.Update, receivedAt: number) => void)[] = [];
  const { promise: gotAuth, resolve: markAuth } = Promise.withResolvers<void>();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  let authState: td.AuthorizationState["@type"] | undefined;
  let open = true;

  const finish = (reason: string) => {
    if (!open) return;
    open = false;
    h.unregisterClient(id, reason);
    markClosed();
  };

  const id = h.registerClient({
    deliver(update, receivedAt) {
      if (update["@type"] === "updateAuthorizationState") {
        authState = update.authorization_state["@type"];
        markAuth();
      }
      try {
        for (const fn of listeners) fn(update, receivedAt);
      } finally {
        if (authState === "authorizationStateClosed") finish("authorizationStateClosed");
      }
    },
    detached: finish,
  });

  // Wake TDLib lazily, just like account.ts does
  h.send(id, { "@type": "getOption", name: "version" }).catch(() => {});

  const client: TestClient = {
    id,
    get isOpen() {
      return open;
    },
    get authState() {
      return authState;
    },
    invoke: (request, options) => h.send(id, request, options),
    onUpdate: (fn) => void listeners.push(fn),
    waitForAuth: () => gotAuth,
    async close() {
      if (!open) return;
      await h.send(id, { "@type": "close" }).catch(() => {});
      await closed;
    },
  };
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await hub?.stop();
  hub = undefined;
  expect(fatalErrors).toEqual([]);
});

process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

describe("createTdHub", () => {
  test("routes responses by @extra and maps errors", async () => {
    const client = openClient(openHub());

    const echoed = await client.invoke({ "@type": "testCallString", x: "你好, robin" });
    expect(echoed).toMatchObject({ "@type": "testString", value: "你好, robin" });

    // Many concurrent requests each get their own answer
    const values = await Promise.all(
      Array.from({ length: 200 }, (_, i) => client.invoke({ "@type": "testSquareInt", x: i })),
    );
    expect(values.map((v) => v.value)).toEqual(Array.from({ length: 200 }, (_, i) => i * i));

    const error = await client
      .invoke({ "@type": "testReturnError", error: { "@type": "error", code: 418, message: "TEAPOT" } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TdError);
    expect(error).toMatchObject({ code: 418, tdMessage: "TEAPOT", method: "testReturnError" });
  });

  test("times out requests that get no answer", async () => {
    const client = openClient(openHub());
    const error = await client
      .invoke({ "@type": "setAlarm", seconds: 1 }, { timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TdTimeoutError);
    expect(hub?.stats.pending).toBe(0);
  });

  test("execute runs synchronously", () => {
    const h = openHub();
    const result = h.execute({ "@type": "getTextEntities", text: "ping @robin" });
    expect(result["@type"]).toBe("textEntities");
    expect(() => h.execute({ "@type": "noSuchMethod" } as unknown as td.Request)).toThrow(TdError);
  });

  test("delivers updates in order with receive timestamps", async () => {
    const client = openClient(openHub());
    const seen: { type: string; receivedAt: number }[] = [];
    const routingFields: string[] = [];
    client.onUpdate((update, receivedAt) => {
      seen.push({ type: update["@type"], receivedAt });
      routingFields.push(...Object.keys(update).filter((key) => key === "@client_id" || key === "@extra"));
    });
    await client.waitForAuth();

    expect(client.authState).toBe("authorizationStateWaitTdlibParameters");
    expect(seen.map((u) => u.type)).toContain("updateOption");
    // The hub routes by these and strips them; updates match td_api.tl exactly
    expect(routingFields).toEqual([]);
    // Date.now() has ms resolution, receive timestamps µs
    const now = (Date.now() + 1) * 1000;
    for (const { receivedAt } of seen) {
      expect(receivedAt).toBeGreaterThan(now - 60_000_000);
      expect(receivedAt).toBeLessThanOrEqual(now);
    }
    const times = seen.map((u) => u.receivedAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("close ends the client and rejects later requests", async () => {
    const h = openHub();
    const client = openClient(h);
    await client.invoke({ "@type": "testCallEmpty" });

    await client.close();
    expect(client.isOpen).toBe(false);
    expect(client.authState).toBe("authorizationStateClosed");
    expect(h.stats.clients).toBe(0);
    await expect(client.invoke({ "@type": "testCallEmpty" })).rejects.toBeInstanceOf(TdClosedError);
  });

  test("allows only one open hub per process", async () => {
    const first = openHub();
    expect(() => createTdHub(hubOptions())).toThrow(/already open/);
    await first.stop();
    // Released after a clean stop
    openHub();
  });

  test("stop rejects pending and later requests", async () => {
    const h = openHub();
    const client = openClient(h);
    await client.invoke({ "@type": "testCallEmpty" });
    const pending = client
      .invoke({ "@type": "setAlarm", seconds: 30 }, { timeoutMs: 0 })
      .catch((e: unknown) => e);
    await h.stop();
    expect(await pending).toBeInstanceOf(TdClosedError);
    await expect(client.invoke({ "@type": "testCallEmpty" })).rejects.toBeInstanceOf(TdClosedError);
    expect(client.isOpen).toBe(false);
  });

  // Regression: an instance still open at exit made TDLib abort the process (SIGABRT, exit 134)
  test("stop closes TDLib instances whose clients were never closed", async () => {
    const h = openHub();
    const client = openClient(h);
    await client.invoke({ "@type": "testCallEmpty" });
    expect(h.stats.instances).toBe(1);

    await h.stop();
    expect(h.stats.instances).toBe(0);
  });

  test("a failing listener reports fatal once and the client still closes normally", async () => {
    const h = openHub();
    const client = openClient(h);
    const seen: string[] = [];
    client.onUpdate((update) => {
      seen.push(update["@type"]);
      if (seen.length === 1) throw new Error("listener broke");
    });

    // The first authorization state is part of TDLib's startup burst, which arrives as one batch
    await client.waitForAuth();
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]?.message).toMatch(/listener broke/);
    // The updates after the failing one still came through
    expect(seen.length).toBeGreaterThan(1);
    fatalErrors.length = 0;

    // Receiving goes on, so the shutdown that fatal starts can close the account in order
    await client.close();
    expect(client.authState).toBe("authorizationStateClosed");
    expect(h.stats.instances).toBe(0);
  });

  test("a crashed receive worker reports fatal once and detaches clients", async () => {
    const h = openHub({ workerUrl: new URL("../fixtures/crash-worker.ts", import.meta.url) });
    let detachedReason: string | undefined;
    h.registerClient({
      deliver() {},
      detached(reason) {
        detachedReason = reason;
      },
    });

    const deadline = Date.now() + 5000;
    while (fatalErrors.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]?.message).toMatch(/injected crash/);
    expect(detachedReason).toBeDefined();
    expect(h.stats.clients).toBe(0);
    fatalErrors.length = 0;

    // A crashed worker exits cleanly on stop so hubOpen is released
    await h.stop();
  });
});

describe("runReceiveLoop", () => {
  test("drains queued items into one batch and exits when stop is set", () => {
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const queue = ["a", "b", "c"];
    const timeouts: number[] = [];
    const posted: WorkerMessage[] = [];

    runReceiveLoop(
      stop,
      { receiveTimeoutSec: 1, maxBatch: 10 },
      {
        receive(timeout) {
          timeouts.push(timeout);
          const next = queue.shift();
          if (next === undefined) Atomics.store(stop, 0, 1);
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
        items: [
          { raw: "a", receivedAt: 1 },
          { raw: "b", receivedAt: 1 },
          { raw: "c", receivedAt: 1 },
        ],
      },
      { type: "stopped" },
    ]);
  });

  test("splits batches at maxBatch", () => {
    const stop = new Int32Array(new SharedArrayBuffer(4));
    let n = 0;
    const batches: string[][] = [];
    runReceiveLoop(
      stop,
      { receiveTimeoutSec: 1, maxBatch: 2 },
      {
        receive() {
          if (n === 5) {
            Atomics.store(stop, 0, 1);
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
});

describe("authorize", () => {
  test("without a session or prompter, a user account fails clearly", async () => {
    const h = openHub();
    const dir = join(tmp, "user-db");
    const parameters: td.setTdlibParameters = {
      "@type": "setTdlibParameters",
      use_test_dc: false,
      database_directory: dir,
      files_directory: join(dir, "files"),
      database_encryption_key: "",
      use_file_database: false,
      use_chat_info_database: false,
      use_message_database: false,
      use_secret_chats: false,
      api_id: 1,
      api_hash: "0123456789abcdef0123456789abcdef",
      system_language_code: "en",
      device_model: "test",
      system_version: "",
      application_version: "0",
    };
    const account = createTdAccount(
      h,
      { name: "user", credentials: { kind: "user", prompter: undefined }, parameters, onFatal: () => {} },
      log,
    );
    const error = await account.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorizationRequiredError);
    expect(account.isReady).toBe(false);
    expect(h.stats.instances).toBe(0);
  });
});
