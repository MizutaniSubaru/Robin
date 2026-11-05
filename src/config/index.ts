import { join, resolve } from "node:path";

import { z } from "zod";

import { type Config, ConfigSchema } from "./schema.ts";

export { type Config, ConfigSchema, LogLevel } from "./schema.ts";

// Runtime paths derived from data_dir
export interface Paths {
  dataDir: string;
  database: string;
  files: string;
  tdlib: string;
  logs: string;
}

export function resolvePaths(config: Config): Paths {
  const dataDir = resolve(config.data_dir);
  return {
    dataDir,
    database: join(dataDir, "robin.db"),
    files: join(dataDir, "files"),
    tdlib: join(dataDir, "tdlib"),
    logs: join(dataDir, "logs"),
  };
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// Load the TOML config from $ROBIN_CONFIG or ./config.toml
export async function loadConfig(path = Bun.env.ROBIN_CONFIG ?? "config.toml"): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${resolve(path)} (copy config.example.toml to get started)`);
  }
  return parseConfig(Bun.TOML.parse(await file.text()));
}
