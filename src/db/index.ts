import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import * as schema from "./schema.ts";

export { schema };

// Resolved from the source tree, so the app must run from sources (not bun build --compile)
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

function createOrm(client: Database) {
  return drizzle({ client, schema });
}

export type Orm = ReturnType<typeof createOrm>;

// A SQLite connection: drizzle for queries, the raw client for pragmas and ad-hoc SQL
export interface Db {
  orm: Orm;
  client: Database;
  close(): void;
}

// The single write connection. Pass ":memory:" for tests
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const client = new Database(path, { create: true, strict: true });
  client.run("PRAGMA journal_mode = WAL");
  client.run("PRAGMA synchronous = NORMAL");
  client.run("PRAGMA foreign_keys = ON");
  client.run("PRAGMA busy_timeout = 5000");
  return { orm: createOrm(client), client, close: () => client.close() };
}

// Read-only connection, not blocked by writes under WAL
export function openReadonlyDb(path: string): Db {
  const client = new Database(path, { readonly: true, strict: true });
  client.run("PRAGMA busy_timeout = 5000");
  return { orm: createOrm(client), client, close: () => client.close() };
}

// Apply pending migrations from migrations/
export function runMigrations(db: Db, migrationsFolder = MIGRATIONS_DIR): void {
  migrate(db.orm, { migrationsFolder });
}
