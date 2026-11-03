import { createApp } from "./app.ts";
import { runProcess } from "./process.ts";

await runProcess(
  "main",
  async ({ config, paths, lc, log }) => {
    await createApp(config, paths, lc);
    log.info("Robin started");
  },
  { keepAlive: true },
);
