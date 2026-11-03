import { type Config, loadConfig, type Paths, resolvePaths } from "./config/index.ts";
import { createLifecycle, type Lifecycle } from "./lifecycle.ts";
import { getLogger, type Logger, setupLogging, shutdownLogging } from "./log/index.ts";

export interface ProcessContext {
  config: Config;
  paths: Paths;
  lc: Lifecycle;
  log: Logger;
}

export interface ProcessOptions {
  // Keep running after body returns, until a signal or the event loop empties
  keepAlive?: boolean;
}

// Process shell shared by main and every CLI command: config, logging, signals, fatal errors, exit code.
// Logging belongs to the process, so it shuts down last, after lc has cleaned up
export async function runProcess(
  name: string,
  body: (ctx: ProcessContext) => Promise<void>,
  { keepAlive = false }: ProcessOptions = {},
): Promise<void> {
  // Fails before logging exists, so Bun prints the stack
  const config = await loadConfig();
  const paths = resolvePaths(config);
  await setupLogging(config.log, paths.logs);
  const log = getLogger(name);
  const lc = createLifecycle((what, error) => log.error("Failed to stop {what}", { what, error }));

  let exiting = false;
  async function exit(code: number, reason: string, error?: unknown): Promise<void> {
    if (exiting) {
      // Second Ctrl+C: stop waiting for cleanup
      if (reason === "SIGINT") process.exit(130);
      if (error) log.error("{reason} during shutdown", { reason, error });
      return;
    }
    exiting = true;
    if (error) log.fatal("{reason}, exiting", { reason, error });
    else log.info("Shutting down ({reason})", { reason });
    await lc.stop();
    await shutdownLogging();
    process.exit(code);
  }

  process.on("SIGINT", () => void exit(0, "SIGINT"));
  process.on("SIGTERM", () => void exit(0, "SIGTERM"));
  process.on("uncaughtException", (error) => void exit(1, "uncaughtException", error));
  process.on("unhandledRejection", (error) => void exit(1, "unhandledRejection", error));
  // Signal handlers don't keep the loop alive; clean up instead of exiting silently
  process.on("beforeExit", () => void exit(0, "nothing left to run"));

  try {
    await body({ config, paths, lc, log });
  } catch (error) {
    return exit(1, "startup failed", error);
  }
  if (!keepAlive) await exit(0, "done");
}
