import type {
  ChatCompletion,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";

import { callOpenAi, createOpenAiClient, type OpenAiClientOptions } from "./openai-shared.ts";
import {
  type AssistantPart,
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type StopReason,
} from "./types.ts";

export interface ChatOptions extends OpenAiClientOptions {
  name: string;
  model: string;
  maxOutputTokens: number;
  // OpenAI's own reasoning models only take max_completion_tokens; many compatible services only max_tokens
  maxTokensParam: "max_completion_tokens" | "max_tokens";
  // Sent as reasoning_effort when set (OpenAI reasoning models, DeepSeek thinking mode)
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
}

// OpenAI Chat Completions, which many other services speak too. Caching is automatic on the
// provider's side (prefix based), so cache hints are not sent
export function createChatProvider(options: ChatOptions): LlmProvider {
  const client = createOpenAiClient(options);

  function toWire(request: LlmRequest): ChatCompletionCreateParamsNonStreaming {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: options.model,
      messages: [{ role: "system", content: request.system }, ...request.messages.flatMap(toWireMessages)],
      tools: request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: "auto",
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    };
    if (options.maxTokensParam === "max_tokens") params.max_tokens = options.maxOutputTokens;
    else params.max_completion_tokens = options.maxOutputTokens;
    return params;
  }

  return {
    name: options.name,
    kind: "chat",
    model: options.model,
    async complete(request, signal) {
      const wireRequest = toWire(request);
      const completion = await callOpenAi(wireRequest, () =>
        client.chat.completions.create(wireRequest, signal ? { signal } : {}),
      );
      const choice = completion.choices[0];
      if (!choice) throw new LlmError("server", "Completion has no choices", wireRequest);
      const message = choice.message;
      const parts: AssistantPart[] = [];
      // Some compatible services (DeepSeek) return their reasoning and want it back with tool calls
      if ("reasoning_content" in message && typeof message.reasoning_content === "string") {
        parts.push({
          type: "opaque",
          provider: "chat",
          data: { reasoning_content: message.reasoning_content },
        });
      }
      if (message.content) parts.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        if (call.type !== "function") continue;
        parts.push({
          type: "tool_call",
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      const usage = completion.usage;
      const cached = cachedTokens(usage);
      return {
        wireRequest,
        wireResponse: completion,
        response: {
          parts,
          stopReason: stopReason(choice.finish_reason),
          model: completion.model,
          usage: {
            // prompt_tokens includes the cached part; Robin counts it separately
            inputTokens: (usage?.prompt_tokens ?? 0) - cached,
            outputTokens: usage?.completion_tokens ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
          },
        },
      };
    },
  };
}

function toWireMessages(message: LlmMessage): ChatCompletionMessageParam[] {
  switch (message.role) {
    case "user":
      return [
        {
          role: "user",
          content: message.parts.map(
            (part): ChatCompletionContentPart =>
              part.type === "text"
                ? { type: "text", text: part.text }
                : { type: "image_url", image_url: { url: `data:${part.mime};base64,${part.data}` } },
          ),
        },
      ];
    case "assistant": {
      const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const calls = message.parts.flatMap((p) =>
        p.type === "tool_call"
          ? [{ id: p.id, type: "function" as const, function: { name: p.name, arguments: p.arguments } }]
          : [],
      );
      const reasoning = message.parts.flatMap((p) => {
        if (p.type !== "opaque") return [];
        if (p.provider !== "chat") throw new Error(`Cannot replay ${p.provider} output to Chat Completions`);
        return [p.data];
      });
      return [
        {
          role: "assistant",
          content: text || null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
          // Non-standard field, passed back as the service sent it
          ...Object.assign({}, ...reasoning),
        },
      ];
    }
    case "tool":
      return message.results.map((result) => ({
        role: "tool",
        tool_call_id: result.callId,
        content: result.isError ? `Error: ${result.content}` : result.content,
      }));
  }
}

// OpenAI reports cache hits in prompt_tokens_details; DeepSeek in its own prompt_cache_hit_tokens
function cachedTokens(usage: ChatCompletion["usage"]): number {
  if (!usage) return 0;
  if (usage.prompt_tokens_details?.cached_tokens !== undefined)
    return usage.prompt_tokens_details.cached_tokens;
  if ("prompt_cache_hit_tokens" in usage && typeof usage.prompt_cache_hit_tokens === "number") {
    return usage.prompt_cache_hit_tokens;
  }
  return 0;
}

function stopReason(reason: ChatCompletion.Choice["finish_reason"]): StopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}
