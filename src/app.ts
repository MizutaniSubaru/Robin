import { createSelfSender, startAgent } from "./agent/index.ts";
import { loadTelegramEnv, type TelegramEnv } from "./config/index.ts";
import { createEventStore, createInbound, createProjection } from "./core/store/index.ts";
import { openDb, runMigrations } from "./db/index.ts";
import { createProvider } from "./llm/index.ts";
import { getLogger } from "./log/index.ts";
import type { ProcessContext } from "./process.ts";
import {
  type AccountName,
  botUserIdFromToken,
  createAccount,
  createIngest,
  createRawUpdateWriter,
  createSendTracker,
  createTelegramAdapter,
  createTelegramSender,
  createUpdateFilter,
  type SendTracker,
  startTdHub,
  type TdAccount,
  userKey,
} from "./sources/tdlib/index.ts";

// Every resource registers its cleanup on lc as soon as it exists, so shutdown runs in reverse:
// the agent stops, accounts close (their last updates are still stored and committed), the receive
// worker stops, buffered raw rows flush, queued inbound events commit, then the db closes
export async function createApp(
  { config, paths, lc, fatal }: ProcessContext,
  env: TelegramEnv = loadTelegramEnv(),
) {
  if (!env.botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const storeLog = getLogger("store");

  const db = openDb(paths.database);
  lc.defer("db", () => db.close());
  runMigrations(db);

  const store = createEventStore(db, storeLog);
  const projection = createProjection(db, store, storeLog, {
    window: { maxItems: config.agent.window.max_items, blockSize: config.agent.window.block_size },
  });
  const inbound = createInbound(store, storeLog, { onFatal: fatal });
  lc.defer("inbound events", () => inbound.close());

  const rawUpdates = createRawUpdateWriter(db, { log: storeLog, onFatal: fatal });
  lc.defer("raw updates", () => rawUpdates.close());

  const hub = startTdHub(config, paths, lc, fatal);
  const adapter = createTelegramAdapter({ botUserId: botUserIdFromToken(env.botToken) });

  const ingestLog = getLogger("ingest");

  // Started one after the other: the user account may prompt for a login on the terminal
  const openAccount = async (
    name: AccountName,
    subscribe?: (account: TdAccount) => void,
  ): Promise<TdAccount> => {
    const account = createAccount(hub, config, paths, env, lc, { name, autoRestart: true, onFatal: fatal });
    account.onUpdate(
      createIngest(name, { filter: createUpdateFilter(name), rawUpdates, adapter, inbound, log: ingestLog }),
    );
    subscribe?.(account);
    await account.start();
    return account;
  };
  const user = await openAccount("user");
  let tracker: SendTracker | undefined;
  const bot = await openAccount("bot", (account) => {
    // Before start: TDLib reports sends it finishes from before a restart right away
    const created = createSendTracker((listener) => account.onUpdate(listener));
    lc.defer("send tracker", () => created.dispose());
    tracker = created;
  });
  if (!tracker) throw new Error("Send tracker was not created");

  const agentLog = getLogger("agent");
  const sender = createSelfSender(store, createTelegramSender(bot, tracker), "bot", agentLog);
  sender.recover();

  const providerName = config.agent.provider;
  const providerConfig = providerName === undefined ? undefined : config.llm.providers[providerName];
  if (providerName === undefined || !providerConfig) {
    agentLog.info("No agent.provider configured: recording events only");
  } else {
    const scheduler = startAgent({
      db,
      store,
      projection,
      provider: createProvider(providerName, providerConfig),
      sender,
      options: {
        persona: config.agent.persona,
        timezone: config.timezone,
        maxSteps: config.agent.max_steps,
        maxSends: config.agent.max_sends_per_run,
        maxTextLength: 4096,
      },
      allowedChats: config.agent.allowed_chats,
      self: { username: bot.me.username, userKey: userKey(bot.me.userId) },
      privateDebounceMs: config.agent.private_debounce_ms,
      onFatal: fatal,
      log: agentLog,
    });
    lc.defer("agent", () => scheduler.stop());
  }

  return { db, hub, store, accounts: { user, bot } };
}
