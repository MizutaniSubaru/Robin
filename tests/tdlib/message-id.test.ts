import { expect, test } from "bun:test";

import { toServerMessageId, toTdMessageId } from "../../src/sources/tdlib/message-id.ts";

test("server ids round-trip through TDLib ids beyond 32 bits", () => {
  for (const serverId of [1, 41, 2_147_483_647, 4_000_000_000]) {
    const tdId = toTdMessageId(serverId);
    expect(tdId).toBe(serverId * 1_048_576);
    expect(toServerMessageId(tdId)).toBe(serverId);
  }
});

test("local, unsent and invalid ids have no server id", () => {
  // Low 20 bits set: yet-unsent / local / scheduled flags
  expect(toServerMessageId(41 * 2 ** 20 + 1)).toBeUndefined();
  expect(toServerMessageId(5)).toBeUndefined();
  expect(toServerMessageId(0)).toBeUndefined();
  expect(toServerMessageId(-(2 ** 20))).toBeUndefined();
  expect(toServerMessageId(2 ** 60)).toBeUndefined();
  expect(() => toTdMessageId(0)).toThrow(RangeError);
  expect(() => toTdMessageId(1.5)).toThrow(RangeError);
});
