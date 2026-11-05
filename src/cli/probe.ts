// Experiments for the M1 TDLib checklist. Run with Robin stopped: TDLib locks its databases.
//
//   bun run probe ids --chat <chat_id>                        T4: message id <-> server id
//   bun run probe outbound --chat <chat_id> --message <id>    T1-T3: bot outbound on messages only the user saw
//       (sendChatAction, sendMessage with reply_to, setMessageReactions: the bot's own APIs)
//       [--fresh-bot]                                         use a throwaway bot database (truly cold cache)
//       [--keep]                                              leave the probe messages and reactions in place
//   bun run probe watch --chat <chat_id> [--open] [--seconds N]   T5: which updates arrive with / without openChat
//
// `outbound` really sends messages and reactions as the bot in that chat, then removes them.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { loadTelegramEnv } from "../config/index.ts";
import { type ProcessContext, runProcess } from "../process.ts";
import {
  type AccountName,
  createAccount,
  createSendTracker,
  startTdHub,
  type TdAccount,
  TdError,
  type TdObject,
  toServerMessageId,
  toTdMessageId,
} from "../sources/tdlib/index.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    chat: { type: "string" },
    message: { type: "string" },
    open: { type: "boolean", default: false },
    seconds: { type: "string", default: "300" },
    "fresh-bot": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});

const out = (line = "") => process.stdout.write(`${line}\n`);

function usage(message: string): never {
  console.error(`${message}\nUsage: bun run probe <ids|outbound|watch> --chat <chat_id> [...]`);
  process.exit(2);
}

const command = positionals[0];
if (command !== "ids" && command !== "outbound" && command !== "watch") usage(`Unknown command "${command}"`);
const chatId = Number(values.chat);
if (!Number.isSafeInteger(chatId) || chatId === 0)
  usage("--chat must be a TDLib chat id, e.g. -1001234567890");

type Step = { step: string; ok: boolean; detail: string };

await runProcess("probe", async (ctx) => {
  switch (command) {
    case "ids":
      return probeIds(ctx);
    case "outbound": {
      const serverId = Number(values.message);
      if (!Number.isSafeInteger(serverId) || serverId <= 0) usage("--message must be a server message id");
      return probeOutbound(ctx, serverId);
    }
    case "watch":
      return probeWatch(ctx, Number(values.seconds));
  }
});

async function openAccounts(
  { config, paths, lc }: ProcessContext,
  names: AccountName[],
  botDatabase?: string,
): Promise<Record<AccountName, TdAccount>> {
  const env = loadTelegramEnv();
  const hub = startTdHub(config, paths, lc, (error) => {
    throw error;
  });
  const accounts = {} as Record<AccountName, TdAccount>;
  for (const name of names) {
    const databaseDirectory = name === "bot" ? botDatabase : undefined;
    const account = createAccount(hub, config, paths, env, lc, {
      name,
      autoRestart: false,
      databaseDirectory,
    });
    await account.start();
    accounts[name] = account;
  }
  return accounts;
}

// Runs a request and records the outcome instead of throwing
async function attempt(steps: Step[], step: string, run: () => Promise<string>): Promise<boolean> {
  try {
    const detail = await run();
    steps.push({ step, ok: true, detail });
    return true;
  } catch (error) {
    const detail = error instanceof TdError ? `${error.code} ${error.tdMessage}` : String(error);
    steps.push({ step, ok: false, detail });
    return false;
  }
}

function printSteps(steps: Step[]): void {
  const width = Math.max(...steps.map((s) => s.step.length));
  for (const { step, ok, detail } of steps)
    out(`  ${ok ? "ok  " : "FAIL"}  ${step.padEnd(width)}  ${detail}`);
}

async function describeChat(user: TdAccount): Promise<TdObject> {
  const chat = await user.invoke({ "@type": "getChat", chat_id: chatId });
  const type = chat.type as TdObject;
  out(`Chat: ${chat.title} (${type["@type"]}${type.is_channel ? ", channel" : ""})`);
  return chat;
}

// T4
async function probeIds(ctx: ProcessContext): Promise<void> {
  const { user } = await openAccounts(ctx, ["user"]);
  await describeChat(user);

  // The first page often comes only from the local database, so page a few times
  const messages: TdObject[] = [];
  let fromMessageId = 0;
  for (let page = 0; page < 4 && messages.length < 20; page++) {
    const result = await user.invoke({
      "@type": "getChatHistory",
      chat_id: chatId,
      from_message_id: fromMessageId,
      offset: 0,
      limit: 20,
      only_local: false,
    });
    const batch = (result.messages as TdObject[] | undefined) ?? [];
    if (batch.length === 0) break;
    messages.push(...batch);
    fromMessageId = Number(batch.at(-1)?.id);
  }

  out(`\n${"tdlib id".padStart(18)}  ${"id / 2^20".padStart(10)}  ${"id % 2^20".padStart(9)}  link id`);
  let consistent = 0;
  for (const message of messages) {
    const id = Number(message.id);
    const serverId = toServerMessageId(id);
    let linkId = "-";
    try {
      const link = await user.invoke({ "@type": "getMessageLink", chat_id: chatId, message_id: id });
      linkId = new URL(String(link.link)).pathname.split("/").at(-1) ?? "-";
    } catch (error) {
      linkId = error instanceof TdError ? `(${error.tdMessage})` : "(error)";
    }
    if (serverId !== undefined && String(serverId) === linkId) consistent++;
    out(
      `${String(id).padStart(18)}  ${String(id / 2 ** 20).padStart(10)}  ${String(id % 2 ** 20).padStart(9)}  ${linkId}`,
    );
  }
  out(`\n${consistent}/${messages.length} messages: id / 2^20 equals the server id in the message link`);
}

// T1-T3
async function probeOutbound(ctx: ProcessContext, serverId: number): Promise<void> {
  const botDatabase = values["fresh-bot"] ? mkdtempSync(join(ctx.paths.tdlib, "probe-bot-")) : undefined;
  if (botDatabase)
    ctx.lc.defer("fresh bot database", () => rmSync(botDatabase, { recursive: true, force: true }));
  const { user, bot } = await openAccounts(ctx, ["user", "bot"], botDatabase);

  const chat = await describeChat(user);
  if ((chat.type as TdObject)["@type"] !== "chatTypeSupergroup") {
    out(
      "Warning: not a supergroup. Message ids differ between accounts in basic groups, so T2/T3 are meaningless",
    );
  }
  const targetId = toTdMessageId(serverId);
  const target = await user.invoke({ "@type": "getMessage", chat_id: chatId, message_id: targetId });
  out(`Target message ${serverId}: ${preview(target)}`);
  out(`Bot database: ${botDatabase ? "fresh (cold)" : "persistent (as after a restart)"}\n`);

  const sends = createSendTracker(bot.onUpdate);
  ctx.lc.defer("send tracker", () => sends.dispose());

  const steps: Step[] = [];
  const probeMessages: number[] = [];
  let reacted = false;

  const chatAction = (label: string) =>
    attempt(steps, `${label} sendChatAction`, async () => {
      await bot.invoke({
        "@type": "sendChatAction",
        chat_id: chatId,
        action: { "@type": "chatActionTyping" },
      });
      return "accepted";
    });

  const reply = (label: string) =>
    attempt(steps, `${label} sendMessage reply_to`, async () => {
      const pending = await bot.invoke({
        "@type": "sendMessage",
        chat_id: chatId,
        reply_to: { "@type": "inputMessageReplyToMessage", message_id: targetId },
        input_message_content: {
          "@type": "inputMessageText",
          text: { "@type": "formattedText", text: `[robin probe] ${label} reply` },
        },
      });
      const localHasReply = pending.reply_to !== undefined && pending.reply_to !== null;
      const final = await sends.wait(Number(pending.id), 20_000);
      const finalId = Number(final.id);
      probeMessages.push(finalId);
      // What everyone else sees, from the user account's point of view
      const seen = await retry(() =>
        user.invoke({ "@type": "getMessage", chat_id: chatId, message_id: finalId }),
      );
      const replyTo = seen.reply_to as TdObject | undefined;
      const kept = Number(replyTo?.message_id) === targetId;
      return `sent as ${toServerMessageId(finalId)}; local reply_to ${localHasReply ? "set" : "missing"}; seen by user: ${kept ? "REPLY KEPT" : "REPLY DROPPED"}`;
    });

  // setMessageReactions replaces the bot's reactions on the message, so repeating it needs no removal
  const react = (label: string) =>
    attempt(steps, `${label} setMessageReactions`, async () => {
      await setReactions([{ "@type": "reactionTypeEmoji", emoji: "👍" }]);
      reacted = true;
      await Bun.sleep(1500);
      const seen = await user.invoke({ "@type": "getMessage", chat_id: chatId, message_id: targetId });
      return `accepted; reactions seen by user: ${describeReactions(seen)}`;
    });

  const setReactions = (reactionTypes: TdObject[]) =>
    bot.invoke({
      "@type": "setMessageReactions",
      chat_id: chatId,
      message_id: targetId,
      reaction_types: reactionTypes,
      is_big: false,
    });

  // Cold: the bot has never loaded the target message in this process
  await chatAction("cold");
  await reply("cold");
  await react("cold");

  // Warm up the way Cahciua does, then repeat
  await attempt(steps, "preheat getChat", async () => {
    const c = await bot.invoke({ "@type": "getChat", chat_id: chatId });
    return String(c.title);
  });
  await attempt(steps, "preheat getMessage", async () => {
    const m = await bot.invoke({ "@type": "getMessage", chat_id: chatId, message_id: targetId });
    return preview(m);
  });
  await chatAction("warm");
  await reply("warm");
  await react("warm");

  out("Results:");
  printSteps(steps);

  if (values.keep) return;
  if (probeMessages.length > 0) {
    await bot
      .invoke({ "@type": "deleteMessages", chat_id: chatId, message_ids: probeMessages, revoke: true })
      .catch((error: unknown) => out(`Could not delete probe messages: ${String(error)}`));
  }
  if (reacted) {
    await setReactions([]).catch((error: unknown) => out(`Could not remove reaction: ${String(error)}`));
  }
  out("\nProbe messages and reactions removed (use --keep to leave them)");
}

// T5
async function probeWatch(ctx: ProcessContext, seconds: number): Promise<void> {
  const { user } = await openAccounts(ctx, ["user"]);
  await describeChat(user);

  const counts = new Map<string, number>();
  user.onUpdate((update) => {
    if (!concernsChat(update)) return;
    const type = update["@type"];
    counts.set(type, (counts.get(type) ?? 0) + 1);
    out(`${new Date().toISOString().slice(11, 23)}  ${type}${describeUpdate(update)}`);
  });
  ctx.lc.defer("watch summary", () => {
    out(`\nUpdates for this chat (${values.open ? "with" : "without"} openChat):`);
    for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1]))
      out(`  ${String(count).padStart(5)}  ${type}`);
  });

  if (values.open) {
    await user.invoke({ "@type": "openChat", chat_id: chatId });
    ctx.lc.defer("closeChat", () => user.invoke({ "@type": "closeChat", chat_id: chatId }).then(() => {}));
  }
  out(
    `Watching for ${seconds} s; edit, react to and delete messages from another device. Ctrl+C to stop early\n`,
  );
  await Bun.sleep(seconds * 1000);
}

function concernsChat(update: TdObject): boolean {
  if (Number(update.chat_id) === chatId) return true;
  const message = update.message as TdObject | undefined;
  return Number(message?.chat_id) === chatId;
}

function describeUpdate(update: TdObject): string {
  const parts: string[] = [];
  const messageId = update.message_id ?? (update.message as TdObject | undefined)?.id;
  if (messageId !== undefined) parts.push(`message ${toServerMessageId(Number(messageId)) ?? messageId}`);
  if (Array.isArray(update.message_ids)) {
    parts.push(`messages ${update.message_ids.map((id) => toServerMessageId(Number(id)) ?? id).join(",")}`);
  }
  if (update.message) parts.push(preview(update.message as TdObject));
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
}

function preview(message: TdObject): string {
  const content = message.content as TdObject | undefined;
  const text = (content?.text as TdObject | undefined)?.text;
  return typeof text === "string" ? JSON.stringify(text.slice(0, 40)) : String(content?.["@type"] ?? "?");
}

function describeReactions(message: TdObject): string {
  const info = message.interaction_info as TdObject | undefined;
  const reactions = ((info?.reactions as TdObject | undefined)?.reactions as TdObject[] | undefined) ?? [];
  if (reactions.length === 0) return "none";
  return reactions
    .map(
      (r) =>
        `${(r.type as TdObject | undefined)?.emoji ?? "?"}x${r.total_count}${r.is_chosen ? " (chosen)" : ""}`,
    )
    .join(" ");
}

async function retry<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (error) {
      if (i >= attempts) throw error;
      await Bun.sleep(1000);
    }
  }
}
