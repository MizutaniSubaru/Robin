import { describe, expect, test } from "bun:test";

import { getLogger } from "../../src/log/index.ts";
import { createTdAccount } from "../../src/sources/tdlib/account.ts";
import { AuthorizationRequiredError } from "../../src/sources/tdlib/auth.ts";
import { TdError } from "../../src/sources/tdlib/errors.ts";
import type { ClientSink, TdHub } from "../../src/sources/tdlib/hub.ts";
import type { td } from "../../src/sources/tdlib/index.ts";
import { update } from "../fixtures/td.ts";

const parameters = { "@type": "setTdlibParameters" } as td.setTdlibParameters;

// Answers just enough of the login flow to reach WaitPhoneNumber; `close` fails
function brokenCloseHub(): TdHub {
  let sink: ClientSink | undefined;
  const authState = (type: td.AuthorizationState["@type"]) =>
    queueMicrotask(() =>
      sink?.deliver(
        update({ "@type": "updateAuthorizationState", authorization_state: { "@type": type } }),
        0,
      ),
    );
  return {
    stats: { generation: 1, restarts: 0, pending: 0, clients: 1, instances: 1 },
    registerClient(s) {
      sink = s;
      authState("authorizationStateWaitTdlibParameters");
      return 1;
    },
    unregisterClient() {},
    send(_clientId, request) {
      switch (request["@type"]) {
        case "getOption":
          return Promise.resolve({ "@type": "optionValueEmpty" } as never);
        case "setTdlibParameters":
          authState("authorizationStateWaitPhoneNumber");
          return Promise.resolve({ "@type": "ok" } as never);
        case "close":
          return Promise.reject(new TdError(500, "close broke", "close"));
        default:
          return Promise.reject(new Error(`Unexpected ${request["@type"]}`));
      }
    },
    execute() {
      throw new Error("Unexpected execute");
    },
    stop: () => Promise.resolve(),
  };
}

describe("createTdAccount", () => {
  // Regression: a failing close used to replace the start error, hiding AuthorizationRequiredError
  test("a failed start rejects with the start error even when close fails", async () => {
    const account = createTdAccount(
      brokenCloseHub(),
      {
        name: "user",
        credentials: { kind: "user", prompter: undefined },
        parameters,
        autoRestart: false,
        onFatal: (error) => {
          throw error;
        },
      },
      getLogger("test"),
    );
    await expect(account.start()).rejects.toBeInstanceOf(AuthorizationRequiredError);
    expect(account.isReady).toBe(false);
  });
});
