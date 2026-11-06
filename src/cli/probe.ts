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
  type td,
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
    case "watch": {
      const seconds = Number(values.seconds);
      if (!Number.isFinite(seconds) || seconds <= 0) usage("--seconds must be a positive number");
      return probeWatch(ctx, seconds);
    }
  }
});

// Hub first, then one started account per name, in order. Callers name exactly the accounts they use
async function openTd(ctx: ProcessContext) {
  const env = loadTelegramEnv();
  const hub = startTdHub(ctx.config, ctx.paths, ctx.lc, ctx.fatal);
  return async (name: AccountName, databaseDirectory?: string): Promise<TdAccount> => {
    const account = createAccount(hub, ctx.config, ctx.paths, env, ctx.lc, {
      name,
      autoRestart: false,
      onFatal: ctx.fatal,
      databaseDirectory,
    });
    await account.start();
    return account;
  };
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

async function describeChat(user: TdAccount): Promise<td.ChatType> {
  const { title, type } = await user.invoke({ "@type": "getChat", chat_id: chatId });
  const channel = type["@type"] === "chatTypeSupergroup" && type.is_channel ? ", channel" : "";
  out(`Chat: ${title} (${type["@type"]}${channel})`);
  return type;
}

// T4
async function probeIds(ctx: ProcessContext): Promise<void> {
  const user = await (await openTd(ctx))("user");
  await describeChat(user);

  // The first page often comes only from the local database, so page a few times
  const messages: td.message[] = [];
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
    // Only getMessages leaves nulls for missing messages; history never does
    const batch = result.messages.map((m) => {
      if (m === null) throw new Error("getChatHistory returned a null message");
      return m;
    });
    const last = batch.at(-1);
    if (last === undefined) break;
    messages.push(...batch);
    fromMessageId = last.id;
  }

  out(`\n${"tdlib id".padStart(18)}  ${"id / 2^20".padStart(10)}  ${"id % 2^20".padStart(9)}  link id`);
  let consistent = 0;
  for (const message of messages) {
    const { id } = message;
    const serverId = toServerMessageId(id);
    let linkId: string;
    try {
      const link = await user.invoke({
        "@type": "getMessageLink",
        chat_id: chatId,
        message_id: id,
        media_timestamp: 0,
        checklist_task_id: 0,
        poll_option_id: "",
        for_album: false,
        in_message_thread: false,
      });
      const path = new URL(link.link).pathname;
      linkId = path.slice(path.lastIndexOf("/") + 1);
    } catch (error) {
      // Some messages have no link (e.g. service messages); that is part of what the probe reports
      if (!(error instanceof TdError)) throw error;
      linkId = `(${error.tdMessage})`;
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
  const open = await openTd(ctx);
  const user = await open("user");
  const bot = await open("bot", botDatabase);

  if ((await describeChat(user))["@type"] !== "chatTypeSupergroup") {
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
        business_connection_id: "",
        action: { "@type": "chatActionTyping" },
      });
      return "accepted";
    });

  const reply = (label: string) =>
    attempt(steps, `${label} sendMessage reply_to`, async () => {
      const pending = await bot.invoke({
        "@type": "sendMessage",
        chat_id: chatId,
        reply_to: {
          "@type": "inputMessageReplyToMessage",
          message_id: targetId,
          checklist_task_id: 0,
          poll_option_id: "",
        },
        input_message_content: {
          "@type": "inputMessageText",
          text: { "@type": "formattedText", text: `[robin probe] ${label} reply`, entities: [] },
          clear_draft: false,
        },
      });
      const localHasReply = pending.reply_to !== undefined;
      const final = await sends.wait(pending.id, 20_000);
      const finalId = final.id;
      probeMessages.push(finalId);
      // What everyone else sees, from the user account's point of view
      const seen = await retry(() =>
        user.invoke({ "@type": "getMessage", chat_id: chatId, message_id: finalId }),
      );
      const kept =
        seen.reply_to?.["@type"] === "messageReplyToMessage" && seen.reply_to.message_id === targetId;
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

  const setReactions = (reactionTypes: td.ReactionType[]) =>
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
    return c.title;
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
    await bot.invoke({
      "@type": "deleteMessages",
      chat_id: chatId,
      message_ids: probeMessages,
      revoke: true,
    });
  }
  if (reacted) await setReactions([]);
  out("\nProbe messages and reactions removed (use --keep to leave them)");
}

// T5
async function probeWatch(ctx: ProcessContext, seconds: number): Promise<void> {
  const user = await (await openTd(ctx))("user");
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

// Updates name their chat either directly or through the message they carry
function concernsChat(update: td.Update): boolean {
  if ("chat_id" in update && update.chat_id === chatId) return true;
  return carriedMessage(update)?.chat_id === chatId;
}

// Business and group call updates carry other objects in their `message` field
function carriedMessage(update: td.Update): td.message | undefined {
  if (!("message" in update) || update.message?.["@type"] !== "message") return undefined;
  return update.message;
}

function describeUpdate(update: td.Update): string {
  const parts: string[] = [];
  const message = carriedMessage(update);
  if ("message_id" in update) parts.push(`message ${formatMessageId(update.message_id)}`);
  if (message) parts.push(`message ${formatMessageId(message.id)}`, preview(message));
  if ("message_ids" in update) parts.push(`messages ${update.message_ids.map(formatMessageId).join(",")}`);
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
}

function formatMessageId(tdMessageId: number): string {
  const serverId = toServerMessageId(tdMessageId);
  return serverId === undefined ? `local:${tdMessageId}` : String(serverId);
}

function preview(message: td.message): string {
  const { content } = message;
  if (content["@type"] !== "messageText") return content["@type"];
  return JSON.stringify(content.text.text.slice(0, 40));
}

function describeReactions(message: td.message): string {
  // Both are null on a message nobody has reacted to
  const reactions = message.interaction_info?.reactions?.reactions ?? [];
  if (reactions.length === 0) return "none";
  return reactions
    .map((r) => `${describeReactionType(r.type)}x${r.total_count}${r.is_chosen ? " (chosen)" : ""}`)
    .join(" ");
}

function describeReactionType(type: td.ReactionType): string {
  switch (type["@type"]) {
    case "reactionTypeEmoji":
      return type.emoji;
    case "reactionTypeCustomEmoji":
      return `custom:${type.custom_emoji_id}`;
    case "reactionTypePaid":
      return "paid";
  }
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
