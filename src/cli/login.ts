// bun run login [--account user|bot]
// Logs an account in and stores its TDLib session under data/tdlib/<account>. Run with Robin stopped:
// TDLib locks its database directory

import { parseArgs } from "node:util";

import { loadTelegramEnv } from "../config/index.ts";
import { runProcess } from "../process.ts";
import {
  type AccountName,
  type AuthPrompter,
  createAccount,
  startTdHub,
  type TdError,
  type td,
} from "../sources/tdlib/index.ts";
import { ask, askSecret } from "./prompt.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { account: { type: "string", default: "user" } },
});

if (values.account !== "user" && values.account !== "bot") {
  console.error(`Unknown account "${values.account}", expected user or bot`);
  process.exit(2);
}
const name: AccountName = values.account;

const prompter: AuthPrompter = {
  phoneNumber: () => ask("Phone number (international format, e.g. +8613800000000): "),
  code: ({ type }) => ask(`Login code (${describeCodeType(type)}): `),
  password: (hint) => askSecret(hint ? `2FA password (hint: ${hint}): ` : "2FA password: "),
  emailAddress: () => ask("Email address for login codes: "),
  emailCode: () => ask("Code sent to your email: "),
  rejected: (error: TdError) => process.stdout.write(`Rejected: ${error.tdMessage}, try again\n`),
};

await runProcess("login", async ({ config, paths, lc, log, fatal }) => {
  const env = loadTelegramEnv();
  const hub = startTdHub(config, paths, lc, fatal);
  const account = createAccount(hub, config, paths, env, lc, {
    name,
    prompter: name === "user" ? prompter : undefined,
    autoRestart: false,
    onFatal: fatal,
  });
  await account.start();
  const { username, displayName, userId } = account.me;
  log.info("Session for {account} saved", { account: name });
  process.stdout.write(`Logged in as ${displayName}${username ? ` (@${username})` : ""}, id ${userId}\n`);
});

function describeCodeType(type: td.AuthenticationCodeType): string {
  switch (type["@type"]) {
    case "authenticationCodeTypeTelegramMessage":
      return "sent to your Telegram app";
    case "authenticationCodeTypeSms":
    case "authenticationCodeTypeSmsWord":
    case "authenticationCodeTypeSmsPhrase":
      return "sent by SMS";
    case "authenticationCodeTypeCall":
      return "by phone call";
    case "authenticationCodeTypeFragment":
      return "sent via Fragment";
    default:
      return type["@type"].replace("authenticationCodeType", "");
  }
}
