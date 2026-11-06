import { expect, test } from "bun:test";

import { TDLIB_COMMIT } from "../../src/tdlib-api/td-api.ts";

test("generated TDLib types match the libtdjson build in use", async () => {
  const pkg = await Bun.file(Bun.resolveSync("prebuilt-tdlib/package.json", import.meta.dir)).json();
  // Fails after a prebuilt-tdlib upgrade until `bun run tdlib:types` is rerun
  expect(TDLIB_COMMIT).toBe(pkg.tdlib.commit);
});
