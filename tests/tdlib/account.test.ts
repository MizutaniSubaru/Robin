import { describe, expect, test } from "bun:test";

import { getLogger } from "../../src/log/index.ts";
import { createTdAccount } from "../../src/sources/tdlib/account.ts";
import { AuthorizationRequiredError } from "../../src/sources/tdlib/auth.ts";
import { TdClosedError, TdError } from "../../src/sources/tdlib/errors.ts";
import type { ClientSink, TdHub } from "../../src/sources/tdlib/hub.ts";
import type { td } from "../../src/sources/tdlib/index.ts";
import { update } from "../fixtures/td.ts";

const parameters = { "@type": "setTdlibParameters" } as td.setTdlibParameters;

// A fake hub that answers login calls and exposes helpers to push authorization states and updates
function fakeHub(options: { ready?: boolean; failClose?: boolean } = {}) {
  let sink: ClientSink | undefined;
  let unregistered = false;
  const push = (u: td.Update) => queueMicrotask(() => sink?.deliver(u, 0));
  const authState = (type: td.AuthorizationState["@type"]) =>
    push(update({ "@type": "updateAuthorizationState", authorization_state: { "@type": type } }));

  const hub: TdHub = {
    stats: { pending: 0, clients: 1, instances: 1 },
    registerClient(s) {
      sink = s;
      authState("authorizationStateWaitTdlibParameters");
      return 1;
    },
    unregisterClient() {
      unregistered = true;
    },
    send(_clientId, request) {
      switch (request["@type"]) {
        case "getOption":
          return Promise.resolve({ "@type": "optionValueEmpty" } as never);
        case "setTdlibParameters":
          authState(options.ready ? "authorizationStateReady" : "authorizationStateWaitPhoneNumber");
          return Promise.resolve({ "@type": "ok" } as never);
        case "getMe":
          return Promise.resolve({
            "@type": "user",
            id: 7,
            first_name: "Alice",
            last_name: "",
            type: { "@type": "userTypeRegular" },
          } as never);
        case "close":
          if (options.failClose) return Promise.reject(new TdError(500, "close broke", "close"));
          authState("authorizationStateClosed");
          return Promise.resolve({ "@type": "ok" } as never);
        default:
          return Promise.reject(new Error(`Unexpected ${request["@type"]}`));
      }
    },
    execute() {
      throw new Error("Unexpected execute");
    },
    stop: () => Promise.resolve(),
  };

  return {
    hub,
    deliver: (u: td.Update) => sink?.deliver(u, 0),
    detach: (reason: string) => sink?.detached(reason),
    isUnregistered: () => unregistered,
  };
}

describe("createTdAccount", () => {
  // Regression: a failing close used to replace the start error, hiding AuthorizationRequiredError
  test("a failed start rejects with the start error even when close fails", async () => {
    const { hub } = fakeHub({ failClose: true });
    const account = createTdAccount(
      hub,
      {
        name: "user",
        credentials: { kind: "user", prompter: undefined },
        parameters,
        onFatal: (error) => {
          throw error;
        },
      },
      getLogger("test"),
    );
    await expect(account.start()).rejects.toBeInstanceOf(AuthorizationRequiredError);
    expect(account.isReady).toBe(false);
  });

  test("unexpected close after startup reports fatal and marks the account not ready", async () => {
    const { hub, deliver, isUnregistered } = fakeHub({ ready: true });
    const fatal: Error[] = [];
    const account = createTdAccount(
      hub,
      {
        name: "user",
        credentials: { kind: "user", prompter: undefined },
        parameters,
        onFatal: (error) => fatal.push(error),
      },
      getLogger("test"),
    );
    await account.start();
    expect(account.isReady).toBe(true);

    deliver(
      update({
        "@type": "updateAuthorizationState",
        authorization_state: { "@type": "authorizationStateClosed" },
      }),
    );
    expect(account.isReady).toBe(false);
    expect(isUnregistered()).toBe(true);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]?.message).toMatch(/closed unexpectedly/);
    await expect(account.invoke({ "@type": "getMe" })).rejects.toBeInstanceOf(TdClosedError);
  });

  test("a terminated session tells the user to log in again", async () => {
    const { hub, deliver } = fakeHub({ ready: true });
    const fatal: Error[] = [];
    const account = createTdAccount(
      hub,
      {
        name: "user",
        credentials: { kind: "user", prompter: undefined },
        parameters,
        onFatal: (error) => fatal.push(error),
      },
      getLogger("test"),
    );
    await account.start();
    deliver(
      update({
        "@type": "updateAuthorizationState",
        authorization_state: { "@type": "authorizationStateLoggingOut" },
      }),
    );
    deliver(
      update({
        "@type": "updateAuthorizationState",
        authorization_state: { "@type": "authorizationStateClosed" },
      }),
    );
    expect(fatal).toHaveLength(1);
    expect(fatal[0]?.message).toMatch(/bun run login --account user/);
  });

  test("a hub detach closes the account without a duplicate fatal", async () => {
    const { hub, detach } = fakeHub({ ready: true });
    const fatal: Error[] = [];
    const account = createTdAccount(
      hub,
      {
        name: "user",
        credentials: { kind: "user", prompter: undefined },
        parameters,
        onFatal: (error) => fatal.push(error),
      },
      getLogger("test"),
    );
    await account.start();
    detach("TDLib stopped");
    expect(account.isReady).toBe(false);
    expect(fatal).toEqual([]);
  });

  test("a throwing listener still delivers to other listeners and still updates auth state", async () => {
    const { hub, deliver } = fakeHub({ ready: true });
    const account = createTdAccount(
      hub,
      {
        name: "user",
        credentials: { kind: "user", prompter: undefined },
        parameters,
        onFatal: () => {},
      },
      getLogger("test"),
    );
    await account.start();

    const other: string[] = [];
    account.onUpdate((u) => {
      if (u["@type"] === "updateOption") throw new Error("listener broke");
    });
    account.onUpdate((u) => other.push(u["@type"]));

    expect(() =>
      deliver(update({ "@type": "updateOption", name: "version", value: { "@type": "optionValueEmpty" } })),
    ).toThrow(/listener broke/);
    expect(other).toEqual(["updateOption"]);

    await account.close();
    expect(account.isReady).toBe(false);
  });
});
