import { loadTelegramEnv, type TelegramEnv } from "./config/index.ts";
import { openDb, runMigrations } from "./db/index.ts";
import { getLogger } from "./log/index.ts";
import type { ProcessContext } from "./process.ts";
import {
  type AccountName,
  createAccount,
  createRawUpdateWriter,
  createUpdateFilter,
  startTdHub,
  type TdAccount,
} from "./sources/tdlib/index.ts";

// Every resource registers its cleanup on lc as soon as it exists, so shutdown runs in reverse:
// accounts close (their last updates still get stored), then the receive worker stops, then buffered rows are flushed, then the db closes
export async function createApp(
  { config, paths, lc, fatal }: ProcessContext,
  env: TelegramEnv = loadTelegramEnv(),
) {
  const db = openDb(paths.database);
  lc.defer("db", () => db.close());
  runMigrations(db);

  const rawUpdates = createRawUpdateWriter(db, { log: getLogger("store"), onFatal: fatal });
  lc.defer("raw updates", () => rawUpdates.close());

  const hub = startTdHub(config, paths, lc, fatal);

  // Started one after the other: the user account may prompt for a login on the terminal
  const openAccount = async (name: AccountName): Promise<TdAccount> => {
    const account = createAccount(hub, config, paths, env, lc, { name, autoRestart: true, onFatal: fatal });
    const filter = createUpdateFilter(name);
    account.onUpdate((update, receivedAt) => {
      if (filter.keep(update)) rawUpdates.push(name, update, receivedAt);
    });
    await account.start();
    return account;
  };
  const accounts = { user: await openAccount("user"), bot: await openAccount("bot") };

  return { db, hub, accounts };
}
