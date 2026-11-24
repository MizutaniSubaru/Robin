// App: builds and connects everything the long-running bot needs (database, event store, TDLib
// accounts, ingest, sender, agent) and registers each part's cleanup

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
  createSendTracker,
  createTelegramAdapter,
  createTelegramSender,
  preloadChats,
  startTdHub,
  type TdAccount,
  userKey,
} from "./sources/tdlib/index.ts";

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

  const hub = startTdHub(config, paths, lc, fatal);
  const adapter = createTelegramAdapter({
    botUserId: botUserIdFromToken(env.botToken),
    log: getLogger("tdlib", "adapter"),
  });

  const ingestLog = getLogger("ingest");

  // Ingest subscribes before start(), so the startup updates are adapted too
  const ingestedAccount = (name: AccountName): TdAccount => {
    const account = createAccount(hub, config, paths, env, lc, { name, onFatal: fatal });
    account.onUpdate(createIngest(name, { adapter, inbound, log: ingestLog }));
    return account;
  };

  // Started one after the other: the user account may prompt for a login on the terminal
  const user = ingestedAccount("user");
  await user.start();
  // Before the bot and the agent: the chats it introduces are known by the time messages need them
  await preloadChats(user, getLogger("tdlib", "user"));

  const bot = ingestedAccount("bot");
  // Before start: TDLib reports sends it finishes from before a restart right away
  const tracker = createSendTracker((listener) => bot.onUpdate(listener));
  lc.defer("send tracker", () => tracker.dispose());
  await bot.start();

  const agentLog = getLogger("agent");
  const telegram = createTelegramSender(bot, tracker);
  const sender = createSelfSender(store, telegram, "bot", agentLog);
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
        maxTextLength: telegram.maxTextLength,
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
