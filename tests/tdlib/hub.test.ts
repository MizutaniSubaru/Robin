// Runs against the real libtdjson, offline: test methods and the pre-login authorization states need no network

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLogger } from "../../src/log/index.ts";
import { AuthorizationRequiredError, authorize } from "../../src/sources/tdlib/auth.ts";
import { createTdClient, type TdClient } from "../../src/sources/tdlib/client.ts";
import { TdClosedError, TdError, TdTimeoutError } from "../../src/sources/tdlib/errors.ts";
import { resolveTdjsonPath, type TdObject } from "../../src/sources/tdlib/ffi.ts";
import { createTdHub, type TdHub, type TdHubOptions } from "../../src/sources/tdlib/hub.ts";

const log = getLogger("test");
const tmp = mkdtempSync(join(tmpdir(), "robin-tdlib-"));
const fatalErrors: Error[] = [];

let hub: TdHub | undefined;
const clients: TdClient[] = [];

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

function openClient(h: TdHub): TdClient {
  const client = createTdClient(h, log);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close(5000)));
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
    expect(() => h.execute({ "@type": "noSuchMethod" })).toThrow(TdError);
  });

  test("delivers updates in order with receive timestamps", async () => {
    const client = openClient(openHub());
    const seen: { type: string; receivedAt: number }[] = [];
    client.onUpdate((update, receivedAt) => seen.push({ type: update["@type"], receivedAt }));
    await client.waitForAuthorizationChange(0);

    expect(client.authorizationState?.["@type"]).toBe("authorizationStateWaitTdlibParameters");
    expect(seen.map((u) => u.type)).toContain("updateOption");
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
    expect(client.authorizationState?.["@type"]).toBe("authorizationStateClosed");
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

  test("restarts a crashed receive worker without losing the client", async () => {
    const marker = join(tmpdir(), `robin-crash-marker-${process.pid}`);
    writeFileSync(marker, "crash");
    try {
      const h = openHub({ workerUrl: new URL("../fixtures/crash-once-worker.ts", import.meta.url) });
      const client = openClient(h);

      // The first batch crashes generation 1; its response may or may not have made it out
      await client.invoke({ "@type": "testCallEmpty" }, { timeoutMs: 1000 }).catch(() => {});
      const deadline = Date.now() + 5000;
      while (h.stats.restarts === 0 && Date.now() < deadline) await Bun.sleep(20);
      expect(h.stats.restarts).toBe(1);

      // The TDLib instance survived; the new worker picks up its responses and updates
      const echoed = await client.invoke({ "@type": "testCallString", x: "after crash" });
      expect(echoed.value).toBe("after crash");
    } finally {
      rmSync(marker, { force: true });
    }
  });
});

describe("authorize", () => {
  test("without a session or prompter, a user account fails clearly", async () => {
    const client = openClient(openHub());
    const dir = join(tmp, "user-db");
    const parameters: TdObject = {
      "@type": "setTdlibParameters",
      database_directory: dir,
      files_directory: join(dir, "files"),
      use_message_database: false,
      api_id: 1,
      api_hash: "0123456789abcdef0123456789abcdef",
      system_language_code: "en",
      device_model: "test",
      application_version: "0",
    };
    const error = await authorize(client, parameters, { kind: "user" }, log).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorizationRequiredError);
    expect(client.authorizationState?.["@type"]).toBe("authorizationStateWaitPhoneNumber");
  });
});
