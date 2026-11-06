import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getRotatingFileSink } from "@logtape/file";
import {
  configure,
  dispose,
  getConsoleSink,
  getLogger as getLogTapeLogger,
  jsonLinesFormatter,
  type Logger,
  type LoggerConfig,
  type Sink,
  withContext,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { type RedactionPattern, redactByField, redactByPattern } from "@logtape/redaction";

import type { Config } from "../config/index.ts";

export type { Logger };
export { withContext };

const REDACTED = "[REDACTED]";

const SENSITIVE_FIELDS = [
  /pass(?:code|phrase|word)/i,
  /secret/i,
  /token/i,
  /api_?key/i,
  /credential/i,
  /auth_?code/i,
  /phone/i,
  /^code$/i,
];

// Matched against the formatted text, so secrets embedded in messages are caught too
const SENSITIVE_PATTERNS: RedactionPattern[] = [
  // Telegram bot token
  { pattern: /\b\d{6,}:[\w-]{30,}\b/g, replacement: REDACTED },
  // sk- prefixed API keys (OpenAI, Anthropic, ...)
  { pattern: /\bsk-[\w-]{16,}/g, replacement: REDACTED },
  // Phone numbers
  { pattern: /\+\d{7,15}\b/g, replacement: REDACTED },
];

const prettyFormatter = getPrettyFormatter({ properties: true });

export function getLogger(...category: string[]): Logger {
  return getLogTapeLogger(["robin", ...category]);
}

export async function setupLogging(config: Config["log"], logDir: string): Promise<void> {
  const sinks: Record<string, Sink> = {};

  if (config.console !== "off") {
    const formatter = config.console === "pretty" ? prettyFormatter : jsonLinesFormatter;
    sinks.console = redactByField(
      getConsoleSink({ formatter: redactByPattern(formatter, SENSITIVE_PATTERNS) }),
      { fieldPatterns: SENSITIVE_FIELDS, action: () => REDACTED },
    );
  }

  if (config.file.enabled) {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    sinks.file = redactByField(
      getRotatingFileSink(join(logDir, "robin.jsonl"), {
        formatter: redactByPattern(jsonLinesFormatter, SENSITIVE_PATTERNS),
        maxSize: config.file.max_size_mb * 1024 * 1024,
        maxFiles: config.file.max_files,
      }),
      { fieldPatterns: SENSITIVE_FIELDS, action: () => REDACTED },
    );
  }

  const sinkIds = Object.keys(sinks);
  const loggers: LoggerConfig<string, string>[] = [
    { category: ["logtape", "meta"], sinks: sinkIds, lowestLevel: "warning" },
    { category: ["robin"], sinks: sinkIds, lowestLevel: config.level },
    // Per-category levels, independent of the global one
    ...Object.entries(config.categories).map(([category, level]) => ({
      category: category.split("."),
      sinks: sinkIds,
      parentSinks: "override" as const,
      lowestLevel: level,
    })),
  ];

  await configure({
    reset: true,
    sinks,
    loggers,
    // Required for withContext()
    contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
  });
}

export async function shutdownLogging(): Promise<void> {
  await dispose();
}
