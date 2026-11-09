import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
} from "openai/resources/responses/responses";

import { callOpenAi, createOpenAiClient, type OpenAiClientOptions } from "./openai-shared.ts";
import {
  type AssistantPart,
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type StopReason,
} from "./types.ts";

export interface ResponsesOptions extends OpenAiClientOptions {
  name: string;
  model: string;
  maxOutputTokens: number;
  // Sent as reasoning.effort when set; the model's default otherwise
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
}

// OpenAI Responses. Stateless: nothing is stored server-side (store: false) and every request
// carries the whole run, as with the other providers. Reasoning items come back with their
// encrypted content and are replayed unchanged within the run. Caching is OpenAI's implicit prefix
// cache, so cache hints are not sent
export function createResponsesProvider(options: ResponsesOptions): LlmProvider {
  const client = createOpenAiClient(options);

  function toWire(request: LlmRequest): ResponseCreateParamsNonStreaming {
    return {
      model: options.model,
      instructions: request.system,
      input: request.messages.flatMap(toWireItems),
      tools: request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true,
      })),
      tool_choice: "auto",
      max_output_tokens: options.maxOutputTokens,
      store: false,
      include: ["reasoning.encrypted_content"],
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
    };
  }

  return {
    name: options.name,
    kind: "responses",
    model: options.model,
    async complete(request, signal) {
      const wireRequest = toWire(request);
      const response = await callOpenAi(wireRequest, () =>
        client.responses.create(wireRequest, signal ? { signal } : {}),
      );
      if (response.error) {
        throw new LlmError("server", `${response.error.code}: ${response.error.message}`, wireRequest);
      }
      const usage = response.usage;
      const cached = usage?.input_tokens_details.cached_tokens ?? 0;
      const written = usage?.input_tokens_details.cache_write_tokens ?? 0;
      return {
        wireRequest,
        wireResponse: response,
        response: {
          parts: response.output.flatMap(fromWireItem),
          stopReason: stopReason(response),
          model: response.model,
          usage: {
            // input_tokens includes the cached and newly cached parts; Robin counts them separately
            inputTokens: (usage?.input_tokens ?? 0) - cached - written,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: written,
          },
        },
      };
    },
  };
}

function toWireItems(message: LlmMessage): ResponseInputItem[] {
  switch (message.role) {
    case "user":
      return [
        {
          type: "message",
          role: "user",
          content: message.parts.map(
            (part): ResponseInputContent =>
              part.type === "text"
                ? { type: "input_text", text: part.text }
                : { type: "input_image", detail: "auto", image_url: `data:${part.mime};base64,${part.data}` },
          ),
        },
      ];
    case "assistant":
      // Item by item and in order: a reasoning item must stay right in front of what followed it
      return message.parts.map(toWireAssistantItem);
    case "tool":
      return message.results.map((result) => ({
        type: "function_call_output",
        call_id: result.callId,
        output: result.isError ? `Error: ${result.content}` : result.content,
      }));
  }
}

function toWireAssistantItem(part: AssistantPart): ResponseInputItem {
  switch (part.type) {
    case "text":
      return { type: "message", role: "assistant", content: part.text };
    case "tool_call":
      return { type: "function_call", call_id: part.id, name: part.name, arguments: part.arguments };
    case "opaque":
      if (part.provider !== "responses")
        throw new Error(`Cannot replay ${part.provider} output to Responses`);
      // Returned exactly as received: reasoning items carry encrypted content checked server-side
      return part.data as ResponseInputItem;
  }
}

function fromWireItem(item: ResponseOutputItem): AssistantPart[] {
  switch (item.type) {
    case "message":
      return item.content.map((content) => ({
        type: "text",
        text: content.type === "output_text" ? content.text : content.refusal,
      }));
    case "function_call":
      return [{ type: "tool_call", id: item.call_id, name: item.name, arguments: item.arguments }];
    default:
      return [{ type: "opaque", provider: "responses", data: item }];
  }
}

function stopReason(response: Response): StopReason {
  const refused = response.output.some(
    (item) => item.type === "message" && item.content.some((c) => c.type === "refusal"),
  );
  if (refused) return "refusal";
  if (response.status === "incomplete") {
    switch (response.incomplete_details?.reason) {
      case "max_output_tokens":
        return "max_tokens";
      case "content_filter":
        return "refusal";
      default:
        return "other";
    }
  }
  if (response.output.some((item) => item.type === "function_call")) return "tool_use";
  return response.status === "completed" ? "end" : "other";
}
