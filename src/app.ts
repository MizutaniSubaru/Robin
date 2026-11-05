import { type Config, loadTelegramEnv, type Paths, type TelegramEnv } from "./config/index.ts";
import { createRawUpdateWriter } from "./core/store/raw-updates.ts";
import { openDb, runMigrations } from "./db/index.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { getLogger } from "./log/index.ts";
import {
  type AccountName,
  createAccount,
  createUpdateFilter,
  startTdHub,
  type TdAccount,
} from "./sources/tdlib/index.ts";

const ACCOUNTS: AccountName[] = ["user", "bot"];

// Wires the long-running app. Every resource registers its cleanup on lc as soon as it exists,
// so shutdown runs in reverse: accounts close (their last updates still get stored),
// then the receive worker stops, then buffered rows are flushed, then the db closes
export async function createApp(
  config: Config,
  paths: Paths,
  lc: Lifecycle,
  env: TelegramEnv = loadTelegramEnv(),
) {
  const db = openDb(paths.database);
  lc.defer("db", () => db.close());
  runMigrations(db);

  // Surfaces as uncaughtException, which runs the normal shutdown and exits non-zero
  const onFatal = (error: Error) => {
    setTimeout(() => {
      throw error;
    });
  };

  const rawUpdates = createRawUpdateWriter(db, { log: getLogger("store"), onFatal });
  lc.defer("raw updates", () => rawUpdates.close());

  const hub = startTdHub(config, paths, lc, onFatal);

  const accounts = {} as Record<AccountName, TdAccount>;
  for (const name of ACCOUNTS) {
    const account = createAccount(hub, config, paths, env, lc, { name, autoRestart: true });
    const filter = createUpdateFilter();
    account.onUpdate((update, receivedAt) => {
      if (filter.keep(update)) rawUpdates.push(name, update, receivedAt);
    });
    await account.start();
    accounts[name] = account;
  }

  return { db, hub, accounts };
}
