import type { Inbound } from "../../core/store/index.ts";
import type { Logger } from "../../log/index.ts";
import type { AccountName } from "./account.ts";
import type { TelegramAdapter } from "./adapter.ts";
import type { UpdateListener } from "./client.ts";
import type { RawUpdateWriter } from "./raw-store.ts";
import type { UpdateFilter } from "./update-filter.ts";

export interface IngestDeps {
  filter: UpdateFilter;
  rawUpdates: Pick<RawUpdateWriter, "push">;
  adapter: TelegramAdapter;
  inbound: Pick<Inbound, "accept">;
  log: Logger;
}

// One account's way in: what the filter keeps goes to raw_updates and through the adapter alike, so
// replaying raw_updates rebuilds the same events.
//
// The adapter is an isolation boundary. An update it cannot turn into events is already on its way
// to raw_updates, and the adapter's memory still holds only what earlier updates taught it, so the
// update is logged and skipped: a fixed adapter replayed over raw_updates brings it back. One odd
// update must not take the bot down. Storing and committing stay fatal: there the data would be lost
export function createIngest(account: AccountName, deps: IngestDeps): UpdateListener {
  return (update, receivedAt) => {
    if (!deps.filter.keep(update)) return;
    deps.rawUpdates.push(account, update, receivedAt);
    let items: ReturnType<TelegramAdapter["adapt"]>;
    try {
      items = deps.adapter.adapt(account, update, receivedAt);
    } catch (error) {
      deps.log.error("Skipped {type} (received {receivedAt}) from {account}: the adapter failed on it", {
        type: update["@type"],
        receivedAt,
        account,
        error,
      });
      return;
    }
    for (const item of items) deps.inbound.accept(item);
  };
}
