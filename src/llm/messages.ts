import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import {
  type AssistantPart,
  LlmError,
  type LlmErrorCategory,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type StopReason,
} from "./types.ts";

export interface MessagesOptions {
  name: string;
  model: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  maxOutputTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  // Server-side refusal fallback: a declined request is re-run on a fallback model in the same call
  refusalFallback: boolean;
  cacheTtl: "5m" | "1h";
  maxRetries: number;
  timeoutMs: number;
  // For tests
  fetch?: typeof fetch;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Anthropic Messages. Thinking is left to the model's default (adaptive on current models); its
// blocks come back as opaque parts and are replayed unchanged within the run
export function createMessagesProvider(options: MessagesOptions): LlmProvider {
  const client = new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    maxRetries: options.maxRetries,
    timeout: options.timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const cacheControl: CacheControl = { type: "ephemeral", ttl: options.cacheTtl };

  // Breakpoints: the system prompt, the parts the request marks (the stable timeline prefix), and
  // the end of the conversation. A cache write only pays off if a later request reads it, so each
  // sits where the next request starts with the same text: the system prompt and the timeline
  // prefix are read by the next run, the conversation's end by the run's next step
  function toWire(request: LlmRequest): BetaMessageCreateParamsNonStreaming {
    return {
      model: options.model,
      max_tokens: options.maxOutputTokens,
      system: [{ type: "text", text: request.system, cache_control: cacheControl }],
      messages: mergeTurns(
        request.messages.map((m, i) => toWireMessage(m, cacheControl, i === request.messages.length - 1)),
      ),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: { ...tool.parameters, type: "object" },
        strict: true,
      })),
      tool_choice: { type: "auto" },
      ...(options.effort ? { output_config: { effort: options.effort } } : {}),
      ...(options.refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };
  }

  return {
    name: options.name,
    kind: "messages",
    model: options.model,
    async complete(request, signal) {
      const wireRequest = toWire(request);
      let message: BetaMessage;
      try {
        message = await client.beta.messages.create(wireRequest, signal ? { signal } : {});
      } catch (error) {
        // Anything but an API error is a bug here, not a failed call
        if (!(error instanceof Anthropic.APIError)) throw error;
        throw new LlmError(categorize(error), error.message, wireRequest, { cause: error });
      }
      const usage = message.usage;
      return {
        wireRequest,
        wireResponse: message,
        response: {
          parts: message.content.map(fromWireBlock),
          stopReason: stopReason(message.stop_reason),
          model: message.model,
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          },
        },
      };
    },
  };
}

type CacheControl = { type: "ephemeral"; ttl: "5m" | "1h" };

// last: the request's final message, whose last block gets the conversation breakpoint. It is a
// user turn (the run's first message, tool results or an update): the run only ever appends to it
function toWireMessage(message: LlmMessage, cacheControl: CacheControl, last: boolean): Turn {
  const cachedAt = (i: number, length: number) => last && i === length - 1;
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: message.parts.map((part, i): BetaContentBlockParam => {
          const cache = part.type === "text" && part.cache === true;
          const control = cache || cachedAt(i, message.parts.length) ? { cache_control: cacheControl } : {};
          if (part.type === "image") {
            return {
              type: "image",
              source: { type: "base64", media_type: imageMime(part.mime), data: part.data },
              ...control,
            };
          }
          const block: BetaTextBlockParam = { type: "text", text: part.text };
          return { ...block, ...control };
        }),
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.parts.map(toWireAssistantPart),
      };
    case "tool":
      return {
        role: "user",
        content: message.results.map((result, i) => ({
          type: "tool_result",
          tool_use_id: result.callId,
          content: result.content,
          is_error: result.isError,
          ...(cachedAt(i, message.results.length) ? { cache_control: cacheControl } : {}),
        })),
      };
  }
}

type Turn = { role: "user" | "assistant"; content: BetaContentBlockParam[] };

// Tool results are a user turn here, so an <update> right after them is a second one; Messages wants
// the roles to alternate, with tool results first in their turn
function mergeTurns(turns: Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const previous = merged.at(-1);
    if (previous?.role === turn.role)
      merged[merged.length - 1] = { ...turn, content: [...previous.content, ...turn.content] };
    else merged.push(turn);
  }
  return merged;
}

function toWireAssistantPart(part: AssistantPart): BetaContentBlockParam {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool_call":
      return { type: "tool_use", id: part.id, name: part.name, input: parseInput(part.arguments) };
    case "opaque":
      if (part.provider !== "messages")
        throw new Error(`Cannot replay ${part.provider} output to Anthropic Messages`);
      // Returned exactly as received: thinking signatures are checked server-side
      return part.data as BetaContentBlockParam;
  }
}

function fromWireBlock(block: BetaContentBlock): AssistantPart {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_call", id: block.id, name: block.name, arguments: JSON.stringify(block.input) };
    default:
      return { type: "opaque", provider: "messages", data: block };
  }
}

// Anthropic only produced valid objects; anything else did not come from it
function parseInput(args: string): Record<string, unknown> {
  const value: unknown = JSON.parse(args);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Tool call arguments are not an object: ${args.slice(0, 100)}`);
  }
  return value as Record<string, unknown>;
}

function imageMime(mime: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  switch (mime) {
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp":
      return mime;
    default:
      throw new Error(`Anthropic does not take ${mime} images`);
  }
}

function stopReason(reason: BetaMessage["stop_reason"]): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

// Most specific first; the SDK has already retried what is retryable
function categorize(error: InstanceType<typeof Anthropic.APIError>): LlmErrorCategory {
  if (error instanceof Anthropic.APIUserAbortError) return "aborted";
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIConnectionError) return "network";
  if (error instanceof Anthropic.RateLimitError) return "rate_limit";
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return "auth";
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return "invalid_request";
  }
  if (error.status === 529) return "overloaded";
  return "server";
}
