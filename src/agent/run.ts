import { type ChatState, reduce } from "../core/reducer/index.ts";
import {
  messageAlias,
  renderChat,
  renderNow,
  renderTimelineBlocks,
  renderUpdate,
} from "../core/render/index.ts";
import type { EventStore, Projection } from "../core/store/index.ts";
import {
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type TextPart,
  type ToolResultPart,
} from "../llm/index.ts";
import type { Logger } from "../log/index.ts";
import { systemPrompt, triggerLine } from "./prompt.ts";
import type { SelfSender } from "./self-sender.ts";
import { runTool, toolSpecs } from "./tools.ts";
import type { Trace } from "./trace.ts";

export interface Trigger {
  reason: "private" | "mention" | "reply";
  // The message that triggered the run, and the ts of its event
  messageId: string;
  ts: number;
}

export interface RunOptions {
  persona: string;
  timezone: string;
  maxSteps: number;
  maxSends: number;
  maxTextLength: number;
}

export interface RunDeps {
  store: EventStore;
  projection: Projection;
  provider: LlmProvider;
  sender: SelfSender;
  trace: Trace;
  log: Logger;
  options: RunOptions;
}

// One run: the model looks at the chat as it is now and may send messages until it ends its turn.
// Before every step after the first, what happened in the chat meanwhile is added as an <update>,
// and tools check against that newer state. Plain text it writes is never sent; only send_message
// speaks. A failed model call ends the run (recorded); anything else is a bug and propagates.
// Resolves to the ts up to which the model has read the chat: a trigger at or before it was seen
export async function runChat(
  deps: RunDeps,
  chat: string,
  trigger: Trigger,
  signal: AbortSignal,
): Promise<number> {
  const { store, projection, provider, sender, trace, log, options } = deps;
  const runId = Bun.randomUUIDv7();
  let state = projection.load(chat);
  const info = store.chatInfo(chat);
  if (!info) throw new Error(`Chat ${chat} has events but no metadata`);

  trace.startRun({
    runId,
    chat,
    trigger: `${trigger.reason}:${messageAlias(trigger.messageId)}`,
    fromTs: state.lastTs,
  });
  log.info("Run {runId} in {chat} ({reason})", { runId, chat, reason: trigger.reason });

  const system = systemPrompt({
    persona: options.persona,
    chatType: info.type,
    timezone: options.timezone,
    maxSends: options.maxSends,
  });
  const tools = toolSpecs();
  const chatLine = renderChat({ kind: info.type === "private" ? "private" : "group", title: info.title });
  const messages: LlmMessage[] = [
    {
      role: "user",
      parts: [
        ...timelineParts(chatLine, state, options),
        {
          type: "text",
          text: `</timeline>\n${renderNow(Date.now(), options)}\n${triggerLine(trigger.reason, messageAlias(trigger.messageId))}`,
        },
      ],
    },
  ];

  let sends = 0;
  // The lastTs of the state in the last request the model answered
  let readTs = 0;
  const finish = (status: "completed" | "failed" | "aborted") => {
    // The run's own messages are in the log now; fold them in so the next run starts from here
    const after = projection.load(chat);
    projection.save(after);
    trace.endRun(runId, status, after.lastTs);
    return readTs;
  };

  try {
    for (let step = 1; step <= options.maxSteps; step++) {
      if (step > 1) {
        const now = reduce(state, store.read(chat, state.lastTs));
        const update = renderUpdate(state, now, options);
        if (update !== undefined) {
          messages.push({
            role: "user",
            parts: [{ type: "text", text: `${update}\n${renderNow(Date.now(), options)}` }],
          });
        }
        state = now;
      }
      const requestTs = state.lastTs;
      const request = { system, messages: [...messages], tools };
      const started = performance.now();
      let exchange: Awaited<ReturnType<LlmProvider["complete"]>>;
      try {
        exchange = await provider.complete(request, signal);
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        trace.llmFailure(
          runId,
          provider.name,
          provider.model,
          request,
          error,
          Math.round(performance.now() - started),
        );
        if (error.category === "aborted") return finish("aborted");
        log.error("Run {runId}: model call failed ({category})", { runId, category: error.category, error });
        return finish("failed");
      }
      trace.llmCall(runId, provider.name, request, exchange, Math.round(performance.now() - started));
      readTs = requestTs;
      const { response } = exchange;
      messages.push({ role: "assistant", parts: response.parts });

      const calls = response.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
      if (calls.length === 0) {
        if (response.stopReason !== "end")
          log.warn("Run {runId} stopped: {reason}", { runId, reason: response.stopReason });
        return finish("completed");
      }

      const results: ToolResultPart[] = [];
      let endTurn = false;
      for (const call of calls) {
        // Stopping: nothing more goes out
        if (signal.aborted) return finish("aborted");
        const result = await runTool(call.name, call.arguments, {
          chat,
          runId,
          state,
          sender,
          maxTextLength: options.maxTextLength,
          maxSends: options.maxSends,
          sends,
          signal,
        });
        if (result.sent) sends++;
        endTurn ||= result.endTurn === true;
        trace.toolCall(runId, {
          name: call.name,
          args: result.args,
          result: result.content,
          status: result.status,
        });
        results.push({ callId: call.id, content: JSON.stringify(result.content), isError: result.isError });
      }
      messages.push({ role: "tool", results });
      if (endTurn) return finish("completed");
    }
    log.warn("Run {runId} used all {steps} steps", { runId, steps: options.maxSteps });
    return finish("completed");
  } catch (error) {
    if (signal.aborted) return finish("aborted");
    trace.endRun(runId, "failed", null);
    throw error;
  }
}

// One part per window block. The cache breakpoint goes after the last complete block: that prefix
// is the same text in every run until the next block fills up, so runs read it instead of writing
// it again. The block still filling up changes with every message and is left out of it
function timelineParts(chatLine: string, state: ChatState, options: RunOptions): TextPart[] {
  const blocks = renderTimelineBlocks(state, options);
  const lastComplete = blocks.findLastIndex((block) => block.complete);
  const parts: TextPart[] = blocks.map((block, i) => ({
    type: "text",
    text: `${i === 0 ? `${chatLine}\n<timeline>\n` : ""}${block.text}\n`,
    ...(i === lastComplete ? { cache: true } : {}),
  }));
  return parts.length > 0 ? parts : [{ type: "text", text: `${chatLine}\n<timeline>\n` }];
}
