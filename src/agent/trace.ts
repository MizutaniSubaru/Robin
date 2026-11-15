// Run trace: records every run, model call and tool call, read back by `bun run inspect`

import { eq } from "drizzle-orm";

import { type Db, schema } from "../db/index.ts";
import type { LlmError, LlmExchange, LlmRequest } from "../llm/index.ts";

export type RunStatus = "completed" | "failed" | "aborted";

// Written to agent_runs / llm_calls / tool_calls: enough to see afterwards what a run saw and did
export interface Trace {
  startRun(run: { runId: string; chat: string; trigger: string; fromTs: number }): void;
  endRun(runId: string, status: RunStatus, toTs: number | null): void;
  llmCall(
    runId: string,
    provider: string,
    request: LlmRequest,
    exchange: LlmExchange,
    latencyMs: number,
  ): void;
  llmFailure(
    runId: string,
    provider: string,
    model: string,
    request: LlmRequest,
    error: LlmError,
    latencyMs: number,
  ): void;
  toolCall(
    runId: string,
    call: { name: string; args: unknown; result: unknown; status: "ok" | "error" | "invalid_args" },
  ): void;
}

export function createTrace(db: Db): Trace {
  return {
    startRun({ runId, chat, trigger, fromTs }) {
      db.orm.insert(schema.agentRuns).values({ runId, chat, trigger, fromTs, status: "running" }).run();
    },
    endRun(runId, status, toTs) {
      db.orm
        .update(schema.agentRuns)
        .set({ status, toTs, endedAt: Date.now() })
        .where(eq(schema.agentRuns.runId, runId))
        .run();
    },
    // request: Robin's own representation (what inspect shows); the response keeps the wire form too
    llmCall(runId, provider, request, exchange, latencyMs) {
      db.orm
        .insert(schema.llmCalls)
        .values({
          runId,
          provider,
          model: exchange.response.model,
          request,
          response: { ir: exchange.response, wire: exchange.wireResponse },
          usage: { ...exchange.response.usage },
          latencyMs,
        })
        .run();
    },
    llmFailure(runId, provider, model, request, error, latencyMs) {
      db.orm
        .insert(schema.llmCalls)
        .values({ runId, provider, model, request, latencyMs, error: `${error.category}: ${error.message}` })
        .run();
    },
    toolCall(runId, call) {
      db.orm
        .insert(schema.toolCalls)
        .values({ runId, ...call })
        .run();
    },
  };
}
