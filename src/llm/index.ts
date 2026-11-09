import type { LlmProviderConfig } from "../config/schema.ts";
import { createChatProvider } from "./chat.ts";
import { createMessagesProvider } from "./messages.ts";
import { createResponsesProvider } from "./responses.ts";
import type { LlmProvider } from "./types.ts";

export { createChatProvider } from "./chat.ts";
export { createMessagesProvider } from "./messages.ts";
export { createResponsesProvider } from "./responses.ts";
export * from "./types.ts";

export function createProvider(
  name: string,
  config: LlmProviderConfig,
  env: Record<string, string | undefined> = Bun.env,
): LlmProvider {
  const apiKey = env[config.api_key_env] || undefined;
  const common = {
    name,
    model: config.model,
    baseUrl: config.base_url,
    maxOutputTokens: config.max_output_tokens,
    maxRetries: config.max_retries,
    timeoutMs: config.timeout_ms,
  };
  const required = (key: string | undefined): string => {
    if (!key) throw new Error(`${config.api_key_env} is not set (llm provider ${name})`);
    return key;
  };
  switch (config.kind) {
    // Without the variable the SDK still finds credentials of its own (ANTHROPIC_AUTH_TOKEN, a CLI
    // login profile), so a missing key is not an error here
    case "messages":
      return createMessagesProvider({
        ...common,
        apiKey,
        effort: config.effort,
        refusalFallback: config.refusal_fallback,
        cacheTtl: config.cache_ttl,
      });
    case "chat":
      return createChatProvider({
        ...common,
        apiKey: required(apiKey),
        maxTokensParam: config.max_tokens_param,
        reasoningEffort: config.reasoning_effort,
      });
    case "responses":
      return createResponsesProvider({
        ...common,
        apiKey: required(apiKey),
        reasoningEffort: config.reasoning_effort,
      });
  }
}
