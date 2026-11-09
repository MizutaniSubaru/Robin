import { describe, expect, test } from "bun:test";

import {
  createChatProvider,
  createMessagesProvider,
  createResponsesProvider,
  LlmError,
  type LlmRequest,
  type StopReason,
} from "../../src/llm/index.ts";

// Captures the request body and answers with a canned JSON response
function fakeFetch(status: number, body: unknown) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const request: LlmRequest = {
  system: "be nice",
  tools: [
    {
      name: "send_message",
      description: "Send",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  ],
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "<timeline/>", cache: true },
        { type: "text", text: "<now/>" },
      ],
    },
    {
      role: "assistant",
      parts: [{ type: "tool_call", id: "call_1", name: "send_message", arguments: '{"text":"hi"}' }],
    },
    { role: "tool", results: [{ callId: "call_1", content: '{"ok":true}', isError: false }] },
  ],
};

describe("Messages provider", () => {
  const options = {
    name: "main",
    model: "claude-opus-5-5",
    apiKey: "test-key",
    baseUrl: undefined,
    maxOutputTokens: 1000,
    effort: "medium" as const,
    refusalFallback: true,
    cacheTtl: "5m" as const,
    maxRetries: 0,
    timeoutMs: 5000,
  };

  test("maps the request and keeps thinking blocks verbatim", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
    const { fetch, requests } = fakeFetch(200, {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [thinking, { type: "tool_use", id: "toolu_2", name: "send_message", input: { text: "yo" } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 0,
      },
    });
    const provider = createMessagesProvider({ ...options, fetch });
    const { response } = await provider.complete(request);

    expect(requests[0]).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 1000,
      system: [{ type: "text", text: "be nice", cache_control: { type: "ephemeral", ttl: "5m" } }],
      tools: [{ name: "send_message", strict: true, input_schema: { type: "object" } }],
      output_config: { effort: "medium" },
      fallbacks: "default",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<timeline/>", cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "text", text: "<now/>" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "send_message", input: { text: "hi" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"ok":true}', is_error: false }],
        },
      ],
    });
    expect(response).toEqual({
      parts: [
        { type: "opaque", provider: "messages", data: thinking },
        { type: "tool_call", id: "toolu_2", name: "send_message", arguments: '{"text":"yo"}' },
      ],
      stopReason: "tool_use",
      model: "claude-opus-5-5",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 0 },
    });

    // The opaque block goes back exactly as it came
    await provider.complete({
      ...request,
      messages: [...request.messages, { role: "assistant", parts: response.parts }],
    });
    expect((requests[1]?.messages as unknown[] | undefined)?.at(-1)).toEqual({
      role: "assistant",
      content: [thinking, { type: "tool_use", id: "toolu_2", name: "send_message", input: { text: "yo" } }],
    });
  });

  test("classifies API errors", async () => {
    const { fetch } = fakeFetch(429, {
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
    });
    const error = await createMessagesProvider({ ...options, fetch })
      .complete(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ category: "rate_limit" });
  });
});

describe("Chat provider", () => {
  const options = {
    name: "alt",
    model: "deepseek-v4-pro",
    apiKey: "test-key",
    baseUrl: undefined,
    maxOutputTokens: 1000,
    maxTokensParam: "max_tokens" as const,
    reasoningEffort: "high" as const,
    maxRetries: 0,
    timeoutMs: 5000,
  };

  test("maps the request and the response, keeping reasoning for the next step", async () => {
    const { fetch, requests } = fakeFetch(200, {
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "thinking...",
            tool_calls: [{ id: "call_9", type: "function", function: { name: "end_turn", arguments: "{}" } }],
          },
        },
      ],
      // DeepSeek's own cache field
      usage: {
        prompt_tokens: 20,
        completion_tokens: 3,
        prompt_cache_hit_tokens: 16,
        prompt_cache_miss_tokens: 4,
      },
    });
    const provider = createChatProvider({ ...options, fetch });
    const { response } = await provider.complete(request);

    expect(requests[0]).toMatchObject({
      model: "deepseek-v4-pro",
      max_tokens: 1000,
      reasoning_effort: "high",
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "send_message" } }],
      messages: [
        { role: "system", content: "be nice" },
        {
          role: "user",
          content: [
            { type: "text", text: "<timeline/>" },
            { type: "text", text: "<now/>" },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "send_message", arguments: '{"text":"hi"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
      ],
    });
    expect(response).toMatchObject({
      parts: [
        { type: "opaque", provider: "chat", data: { reasoning_content: "thinking..." } },
        { type: "tool_call", id: "call_9", name: "end_turn", arguments: "{}" },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 16, cacheWriteTokens: 0 },
    });

    await provider.complete({ ...request, messages: [{ role: "assistant", parts: response.parts }] });
    expect((requests[1]?.messages as unknown[] | undefined)?.at(-1)).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "thinking...",
      tool_calls: [{ id: "call_9", type: "function", function: { name: "end_turn", arguments: "{}" } }],
    });
  });

  test("refuses to replay another provider's opaque output", async () => {
    const { fetch } = fakeFetch(200, {});
    const provider = createChatProvider({ ...options, fetch });
    await expect(
      provider.complete({
        ...request,
        messages: [{ role: "assistant", parts: [{ type: "opaque", provider: "messages", data: {} }] }],
      }),
    ).rejects.toThrow(/Cannot replay messages/);
  });
});

describe("Responses provider", () => {
  const options = {
    name: "openai",
    model: "gpt-5.5",
    apiKey: "test-key",
    baseUrl: undefined,
    maxOutputTokens: 1000,
    reasoningEffort: "medium" as const,
    maxRetries: 0,
    timeoutMs: 5000,
  };

  const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "enc-abc" };
  const responseBody = (output: unknown[], extra: Record<string, unknown> = {}) => ({
    id: "resp_1",
    object: "response",
    created_at: 1,
    model: "gpt-5.5",
    status: "completed",
    error: null,
    incomplete_details: null,
    output,
    usage: {
      input_tokens: 30,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 4 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 36,
    },
    ...extra,
  });

  test("maps the request statelessly and keeps reasoning items for the next step", async () => {
    const { fetch, requests } = fakeFetch(
      200,
      responseBody([
        reasoning,
        { type: "function_call", id: "fc_1", call_id: "call_9", name: "end_turn", arguments: "{}" },
      ]),
    );
    const provider = createResponsesProvider({ ...options, fetch });
    const { response } = await provider.complete(request);

    expect(requests[0]).toMatchObject({
      model: "gpt-5.5",
      instructions: "be nice",
      max_output_tokens: 1000,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium" },
      tool_choice: "auto",
      tools: [{ type: "function", name: "send_message", strict: true }],
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<timeline/>" },
            { type: "input_text", text: "<now/>" },
          ],
        },
        { type: "function_call", call_id: "call_1", name: "send_message", arguments: '{"text":"hi"}' },
        { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
      ],
    });
    expect(response).toEqual({
      parts: [
        { type: "opaque", provider: "responses", data: reasoning },
        { type: "tool_call", id: "call_9", name: "end_turn", arguments: "{}" },
      ],
      stopReason: "tool_use",
      model: "gpt-5.5",
      usage: { inputTokens: 6, outputTokens: 6, cacheReadTokens: 20, cacheWriteTokens: 4 },
    });

    // The reasoning item goes back verbatim, in front of the call it led to
    await provider.complete({ ...request, messages: [{ role: "assistant", parts: response.parts }] });
    expect(requests[1]?.input).toEqual([
      reasoning,
      { type: "function_call", call_id: "call_9", name: "end_turn", arguments: "{}" },
    ]);
  });

  test("maps text, refusals and truncation to stop reasons", async () => {
    const text = (t: string) => ({
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: t, annotations: [] }],
    });
    const cases: [unknown, StopReason][] = [
      [responseBody([text("hello")]), "end"],
      [responseBody([{ ...text(""), content: [{ type: "refusal", refusal: "no" }] }]), "refusal"],
      [
        responseBody([text("cut")], {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
        "max_tokens",
      ],
    ];
    for (const [body, expected] of cases) {
      const { fetch } = fakeFetch(200, body);
      const { response } = await createResponsesProvider({ ...options, fetch }).complete(request);
      expect(response.stopReason).toBe(expected);
    }
  });

  test("classifies API errors", async () => {
    const { fetch } = fakeFetch(401, { error: { message: "bad key", type: "invalid_request_error" } });
    const error = await createResponsesProvider({ ...options, fetch })
      .complete(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ category: "auth" });
  });
});
