// Robin's intermediate representation of a model call. The agent speaks only this; each provider
// translates it to its own wire format and back. Nothing here is specific to one vendor.

export interface TextPart {
  type: "text";
  text: string;
  // Everything up to and including this part is a stable prefix worth caching
  cache?: boolean;
}

export interface ImagePart {
  type: "image";
  mime: string;
  // Base64
  data: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  // The arguments exactly as the model wrote them (JSON text), possibly invalid: the tool layer
  // parses and validates, and the provider replays them unchanged
  arguments: string;
}

// Provider-specific output that must go back verbatim on the next step (thinking blocks with their
// signatures, fallback markers, reasoning text). Only the provider that produced it reads it
export interface OpaquePart {
  type: "opaque";
  provider: ProviderKind;
  data: unknown;
}

export interface ToolResultPart {
  callId: string;
  content: string;
  isError: boolean;
}

export type AssistantPart = TextPart | ToolCallPart | OpaquePart;

export type LlmMessage =
  | { role: "user"; parts: (TextPart | ImagePart)[] }
  | { role: "assistant"; parts: AssistantPart[] }
  | { role: "tool"; results: ToolResultPart[] };

export interface ToolSpec {
  name: string;
  description: string;
  // JSON Schema of the arguments object
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

// Input is split the same way for every provider: inputTokens are the uncached ones
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  parts: AssistantPart[];
  stopReason: StopReason;
  usage: LlmUsage;
  // The model that actually answered (a fallback may have taken over)
  model: string;
}

// One call, with what went over the wire, for llm_calls
export interface LlmExchange {
  response: LlmResponse;
  wireRequest: unknown;
  wireResponse: unknown;
}

// The wire protocol, not the vendor: many services speak one of these
export type ProviderKind = "messages" | "chat" | "responses";

export interface LlmProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly model: string;
  // Throws LlmError
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmExchange>;
}

export type LlmErrorCategory =
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "network"
  | "auth"
  | "invalid_request"
  | "server"
  | "aborted";

export class LlmError extends Error {
  override readonly name = "LlmError";
  constructor(
    readonly category: LlmErrorCategory,
    message: string,
    readonly wireRequest: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
