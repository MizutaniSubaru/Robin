// Ingest: where one account's TDLib updates enter Robin. Each update takes three steps:
//   1. the update filter decides whether Robin keeps it at all;
//   2. a kept update is stored unchanged in raw_updates;
//   3. the adapter turns it into Robin events, which go to the inbound queues to be committed.
// Steps 2 and 3 see exactly the same updates, so replaying raw_updates rebuilds the same events

import type { Inbound } from "../../core/store/index.ts";
import type { Logger } from "../../log/index.ts";
import type * as td from "../../tdlib-api/td-api.ts";
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

export function createIngest(account: AccountName, deps: IngestDeps): UpdateListener {
  // The filter is part of the isolation boundary too: a filter bug must not stop the bot, and storing
  // an update it failed on keeps the record a replay needs
  function keep(update: td.Update, receivedAt: number): boolean {
    try {
      return deps.filter.keep(update);
    } catch (error) {
      deps.log.error("The update filter failed on {type} (received {receivedAt}) from {account}; kept it", {
        type: update["@type"],
        receivedAt,
        account,
        error,
      });
      return true;
    }
  }

  return (update, receivedAt) => {
    if (!keep(update, receivedAt)) return;
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
