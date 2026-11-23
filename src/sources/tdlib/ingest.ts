// Ingest: where one account's TDLib updates enter Robin. Adapts each update into Robin events and
// hands them to the inbound queues; an adapter error is logged with the update and skipped so one
// bad update never stops the bot

import type { Inbound } from "../../core/store/index.ts";
import type { Logger } from "../../log/index.ts";
import type { AccountName, UpdateListener } from "./account.ts";
import type { TelegramAdapter } from "./adapter.ts";

export interface IngestDeps {
  adapter: TelegramAdapter;
  inbound: Pick<Inbound, "accept">;
  log: Logger;
}

export function createIngest(account: AccountName, deps: IngestDeps): UpdateListener {
  return (update, receivedAt) => {
    let items: ReturnType<TelegramAdapter["adapt"]>;
    try {
      items = deps.adapter.adapt(account, update, receivedAt);
    } catch (error) {
      deps.log.error("Skipped {type} (received {receivedAt}) from {account}: the adapter failed on it", {
        type: update["@type"],
        receivedAt,
        account,
        update,
        error,
      });
      return;
    }
    for (const item of items) deps.inbound.accept(item);
  };
}
