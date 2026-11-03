import type { Config, Paths } from "./config/index.ts";
import { openDb, runMigrations } from "./db/index.ts";
import type { Lifecycle } from "./lifecycle.ts";

// Wires the long-running app. Every resource registers its cleanup on lc as soon as it exists.
// Planned order for M1: db → tdlib clients → chat queues → runner → update subscription,
// so shutdown unsubscribes first, then waits for runs, drains queues, closes tdlib, closes db
export async function createApp(_config: Config, paths: Paths, lc: Lifecycle) {
  const db = openDb(paths.database);
  lc.defer("db", () => db.close());
  runMigrations(db);

  return { db };
}
