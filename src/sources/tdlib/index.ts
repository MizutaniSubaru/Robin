import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Config, Paths, TelegramEnv } from "../../config/index.ts";
import type { Lifecycle } from "../../lifecycle.ts";
import { getLogger } from "../../log/index.ts";
import type * as td from "../../tdlib-api/td-api.ts";
import { type AccountName, createTdAccount, type TdAccount } from "./account.ts";
import type { AuthPrompter, Credentials } from "./auth.ts";
import { resolveTdjsonPath } from "./ffi.ts";
import { createTdHub, type TdHub } from "./hub.ts";

export type * as td from "../../tdlib-api/td-api.ts";
export type { AccountIdentity, AccountName, TdAccount } from "./account.ts";
export { AuthorizationRequiredError, type AuthPrompter } from "./auth.ts";
export type { TdClient, UpdateListener } from "./client.ts";
export { TdClosedError, TdError, TdTimeoutError } from "./errors.ts";
export type { TdHub } from "./hub.ts";
export { toServerMessageId, toTdMessageId } from "./message-id.ts";
export { createRawUpdateWriter, type RawUpdateWriter } from "./raw-store.ts";
export { createSendTracker, type SendTracker } from "./send-tracker.ts";
export { createUpdateFilter, type UpdateFilter } from "./update-filter.ts";

const APP_VERSION = "0.0.0";

// Starts the process-wide hub and registers its shutdown on lc.
// onFatal fires when receiving cannot recover in-process; callers should exit
export function startTdHub(
  config: Config,
  paths: Paths,
  lc: Lifecycle,
  onFatal: (error: Error) => void,
): TdHub {
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const hub = createTdHub({
    libraryPath: resolveTdjsonPath(config.tdlib.library_path),
    logVerbosity: config.tdlib.log_verbosity,
    logFile: paths.tdlibLog,
    log: getLogger("tdlib"),
    onFatal,
  });
  lc.defer("tdlib", () => hub.stop());
  return hub;
}

export interface AccountSetup {
  name: AccountName;
  // For the user account; without it only an existing session works
  prompter?: AuthPrompter | undefined;
  autoRestart: boolean;
  onFatal(error: Error): void;
  // Defaults to data/tdlib/<name>
  databaseDirectory?: string | undefined;
}

// Creates the account and registers its close on lc. Call start() after subscribing to updates
export function createAccount(
  hub: TdHub,
  config: Config,
  paths: Paths,
  env: TelegramEnv,
  lc: Lifecycle,
  { name, prompter, autoRestart, onFatal, databaseDirectory = join(paths.tdlib, name) }: AccountSetup,
): TdAccount {
  let credentials: Credentials;
  if (name === "bot") {
    if (!env.botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    credentials = { kind: "bot", token: env.botToken };
  } else {
    credentials = { kind: "user", prompter };
  }

  const account = createTdAccount(
    hub,
    { name, credentials, parameters: tdlibParameters(config, env, databaseDirectory), autoRestart, onFatal },
    getLogger("tdlib", name),
  );
  lc.defer(`tdlib ${name}`, () => account.close());
  return account;
}

// The auth key lives in database_directory: keep it private (0700) and out of git (data/)
function tdlibParameters(config: Config, env: TelegramEnv, databaseDirectory: string): td.setTdlibParameters {
  mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
  return {
    "@type": "setTdlibParameters",
    use_test_dc: config.tdlib.use_test_dc,
    database_directory: databaseDirectory,
    files_directory: join(databaseDirectory, "files"),
    database_encryption_key: "",
    use_file_database: true,
    use_chat_info_database: true,
    use_message_database: true,
    use_secret_chats: false,
    api_id: env.apiId,
    api_hash: env.apiHash,
    system_language_code: "en",
    device_model: "Robin",
    system_version: "",
    application_version: APP_VERSION,
  };
}
