import { expect, test } from "bun:test";

import { createApp } from "../src/app.ts";
import { type Paths, parseConfig } from "../src/config/index.ts";
import { createLifecycle } from "../src/lifecycle.ts";

test("createApp migrates the database and stop closes it", async () => {
  const paths: Paths = { dataDir: "", database: ":memory:", files: "", tdlib: "", logs: "" };
  const lc = createLifecycle((name, error) => {
    throw new Error(`cleanup ${name} failed: ${error}`);
  });
  const { db } = await createApp(parseConfig({}), paths, lc);

  const tables = db.client.query("SELECT name FROM sqlite_master WHERE name = 'events'").all();
  expect(tables).toHaveLength(1);

  await lc.stop();
  expect(() => db.client.query("SELECT 1").get()).toThrow();
});
