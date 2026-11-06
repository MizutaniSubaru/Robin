import { createApp } from "./app.ts";
import { runProcess } from "./process.ts";

await runProcess(
  "main",
  async (ctx) => {
    await createApp(ctx);
    ctx.log.info("Robin started");
  },
  { keepAlive: true },
);
