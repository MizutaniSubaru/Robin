// What the Chat Completions and Responses providers share: both go through the OpenAI SDK
import OpenAI from "openai";

import { LlmError, type LlmErrorCategory } from "./types.ts";

export interface OpenAiClientOptions {
  apiKey: string;
  baseUrl: string | undefined;
  maxRetries: number;
  timeoutMs: number;
  // For tests
  fetch?: typeof fetch;
}

export function createOpenAiClient(options: OpenAiClientOptions): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    maxRetries: options.maxRetries,
    timeout: options.timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

// Only API errors are failed calls; anything else thrown by the SDK is a bug and propagates
export async function callOpenAi<T>(wireRequest: unknown, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof OpenAI.APIError)) throw error;
    throw new LlmError(categorize(error), error.message, wireRequest, { cause: error });
  }
}

// Most specific first; the SDK has already retried what is retryable
function categorize(error: InstanceType<typeof OpenAI.APIError>): LlmErrorCategory {
  if (error instanceof OpenAI.APIUserAbortError) return "aborted";
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (error instanceof OpenAI.APIConnectionError) return "network";
  if (error instanceof OpenAI.RateLimitError) return "rate_limit";
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError)
    return "auth";
  if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.NotFoundError)
    return "invalid_request";
  return "server";
}
