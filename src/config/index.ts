import { join, resolve } from "node:path";

import { z } from "zod";

import { type Config, ConfigSchema } from "./schema.ts";

export { type Config, ConfigSchema, LogLevel } from "./schema.ts";

export interface Paths {
  dataDir: string;
  database: string;
  files: string;
  tdlib: string;
  logs: string;
  tdlibLog: string;
}

export function resolvePaths(config: Config): Paths {
  const dataDir = resolve(config.data_dir);
  return {
    dataDir,
    database: join(dataDir, "robin.db"),
    files: join(dataDir, "files"),
    tdlib: join(dataDir, "tdlib"),
    logs: join(dataDir, "logs"),
    tdlibLog: join(dataDir, "logs", "tdlib.log"),
  };
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadConfig(path = Bun.env.ROBIN_CONFIG ?? "config.toml"): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${resolve(path)} (copy config.example.toml to get started)`);
  }
  return parseConfig(Bun.TOML.parse(await file.text()));
}

const TelegramEnvSchema = z.object({
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().regex(/^[0-9a-f]{32}$/i, "must be 32 hex characters"),
  // `TELEGRAM_BOT_TOKEN=` in .env arrives as "", which means unset, not an invalid token
  TELEGRAM_BOT_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^\d+:[\w-]+$/, "must look like 123456:ABC-DEF")
      .optional(),
  ),
});

// Telegram secrets live in the environment, never in config.toml
export interface TelegramEnv {
  apiId: number;
  apiHash: string;
  botToken: string | undefined;
}

export function loadTelegramEnv(env: Record<string, string | undefined> = Bun.env): TelegramEnv {
  const result = TelegramEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid Telegram environment (see .env.example):\n${z.prettifyError(result.error)}`);
  }
  return {
    apiId: result.data.TELEGRAM_API_ID,
    apiHash: result.data.TELEGRAM_API_HASH,
    botToken: result.data.TELEGRAM_BOT_TOKEN,
  };
}
