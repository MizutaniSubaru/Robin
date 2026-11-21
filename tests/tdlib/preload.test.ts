import { describe, expect, test } from "bun:test";

import { getLogger } from "../../src/log/index.ts";
import type { TdAccount } from "../../src/sources/tdlib/account.ts";
import { TdClosedError, TdError } from "../../src/sources/tdlib/errors.ts";
import { preloadChats, type td } from "../../src/sources/tdlib/index.ts";

// An account whose loadChats answers with `answers` in turn
function fakeAccount(answers: (Error | null)[]) {
  const requests: td.Request[] = [];
  const account: Pick<TdAccount, "invoke"> = {
    invoke: async <R extends td.Request>(request: R) => {
      requests.push(request);
      const answer = answers.shift();
      if (answer) throw answer;
      return { "@type": "ok" } as td.ResultOf<R>;
    },
  };
  return { account, requests };
}

describe("preloadChats", () => {
  test("loads the main chat list until TDLib says it is all loaded", async () => {
    const { account, requests } = fakeAccount([null, null, new TdError(404, "Not Found", "loadChats")]);
    await preloadChats(account, getLogger("test"));
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({ "@type": "loadChats", chat_list: { "@type": "chatListMain" }, limit: 100 });
  });

  test("stops after a bounded number of calls on a long list", async () => {
    const { account, requests } = fakeAccount([]);
    await preloadChats(account, getLogger("test"));
    expect(requests).toHaveLength(5);
  });

  test("never throws: it is only a warm-up", async () => {
    for (const error of [new TdError(400, "Bad Request", "loadChats"), new TdClosedError("closed")]) {
      const { account, requests } = fakeAccount([error]);
      await preloadChats(account, getLogger("test"));
      expect(requests).toHaveLength(1);
    }
  });
});
