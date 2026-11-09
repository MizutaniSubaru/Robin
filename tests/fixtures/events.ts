import type { BodyOf, EventKind, RobinEvent } from "../../src/core/events/index.ts";

export const CHAT = "tg:-100123";

// Builds committed events with increasing ts, as the store would
export function createEventFactory(chat = CHAT, startTs = 1_800_000_000_000_000) {
  let ts = startTs;
  let n = 0;
  return function event<K extends EventKind>(
    body: BodyOf<K>,
    meta: { serverDate?: number | null; account?: string; eventId?: string } = {},
  ): RobinEvent {
    ts += 1_000_000;
    n++;
    return {
      eventId: meta.eventId ?? `e${n}`,
      chat,
      account: meta.account ?? "user",
      ts,
      tsSource: "local",
      serverDate: meta.serverDate === undefined ? Math.floor(ts / 1_000_000) : meta.serverDate,
      ...body,
    };
  };
}

export function text(value: string) {
  return [{ type: "text" as const, text: value, entities: [] }];
}
