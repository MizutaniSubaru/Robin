// Config schema: the shape and defaults of config.toml

import { z } from "zod";

export const LogLevel = z.enum(["trace", "debug", "info", "warning", "error", "fatal"]);
export type LogLevel = z.infer<typeof LogLevel>;

const IanaTimezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid IANA timezone" },
);

const LogConfig = z.object({
  level: LogLevel.default("info"),
  console: z.enum(["pretty", "json", "off"]).default("pretty"),
  // Per-category levels, e.g. "robin.tdlib" = "debug"
  categories: z.record(z.string().regex(/^robin(\.[\w-]+)*$/), LogLevel).default({}),
  file: z
    .object({
      enabled: z.boolean().default(true),
      max_size_mb: z.number().positive().default(20),
      max_files: z.number().int().positive().default(10),
    })
    .prefault({}),
});

const TdlibConfig = z.object({
  // libtdjson to load; defaults to the prebuilt-tdlib build for this platform
  library_path: z.string().min(1).optional(),
  // TDLib's own log (data/logs/tdlib.log): 0 fatal, 1 errors, 2 warnings, 3 info, 4 debug, 5 verbose
  log_verbosity: z.number().int().min(0).max(5).default(2),
  use_test_dc: z.boolean().default(false),
});

const ProviderCommon = {
  model: z.string().min(1),
  base_url: z.url().optional(),
  // Name of the environment variable holding the API key
  api_key_env: z.string().min(1),
  max_output_tokens: z.number().int().positive().default(16_000),
  // Retries of the SDK itself (rate limits, 5xx, connection errors)
  max_retries: z.number().int().nonnegative().default(2),
  timeout_ms: z.number().int().positive().default(600_000),
};

// kind names the wire protocol, not the vendor: any service speaking it can be used through base_url
const LlmProviderConfig = z.discriminatedUnion("kind", [
  // Anthropic Messages
  z.object({
    kind: z.literal("messages"),
    ...ProviderCommon,
    model: ProviderCommon.model.default("claude-opus-5-5"),
    api_key_env: ProviderCommon.api_key_env.default("ANTHROPIC_API_KEY"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    // Let the API re-run a declined request on a fallback model
    refusal_fallback: z.boolean().default(true),
    cache_ttl: z.enum(["5m", "1h"]).default("5m"),
  }),
  // OpenAI Chat Completions
  z.object({
    kind: z.literal("chat"),
    ...ProviderCommon,
    api_key_env: ProviderCommon.api_key_env.default("OPENAI_API_KEY"),
    max_tokens_param: z.enum(["max_completion_tokens", "max_tokens"]).default("max_completion_tokens"),
    // OpenAI reasoning models, DeepSeek thinking mode; the service's default when unset
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  }),
  // OpenAI Responses
  z.object({
    kind: z.literal("responses"),
    ...ProviderCommon,
    api_key_env: ProviderCommon.api_key_env.default("OPENAI_API_KEY"),
    // The model's default when unset
    reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  }),
]);
export type LlmProviderConfig = z.infer<typeof LlmProviderConfig>;

const LlmConfig = z.object({
  providers: z.record(z.string().min(1), LlmProviderConfig).default({}),
});

const AgentConfig = z.object({
  // Provider (a key of llm.providers) the agent talks to; without one Robin only records events
  provider: z.string().min(1).optional(),
  persona: z.string().default("You are Robin, a friendly and concise member of this chat."),
  // Chat keys the agent may answer in, e.g. "tg:-1001234567890" (group) or "tg:bot:12345" (private
  // chat with the bot). Events are recorded for every chat either way
  allowed_chats: z.array(z.string().regex(/^tg:(bot:)?-?\d+$/)).default([]),
  // A private chat is answered once it has been quiet this long, so a burst of messages gets one run
  private_debounce_ms: z.number().int().nonnegative().default(5_000),
  max_steps: z.number().int().positive().default(8),
  max_sends_per_run: z.number().int().positive().default(3),
  window: z
    .object({
      max_items: z.number().int().positive().default(300),
      block_size: z.number().int().positive().default(50),
    })
    .prefault({})
    .refine((w) => w.block_size <= w.max_items, { message: "block_size must not exceed max_items" }),
});

export const ConfigSchema = z
  .object({
    timezone: IanaTimezone.default("Asia/Shanghai"),
    data_dir: z.string().min(1).default("data"),
    log: LogConfig.prefault({}),
    tdlib: TdlibConfig.prefault({}),
    llm: LlmConfig.prefault({}),
    agent: AgentConfig.prefault({}),
  })
  .refine((c) => c.agent.provider === undefined || c.agent.provider in c.llm.providers, {
    message: "agent.provider must name one of llm.providers",
    path: ["agent", "provider"],
  });

export type Config = z.infer<typeof ConfigSchema>;
