// Read-only views of what Robin recorded. Safe to run while Robin is running.
//
//   bun run inspect chat <chat_key>                 the chat as the model would see it now
//   bun run inspect runs [--chat <chat_key>] [-n N] recent runs
//   bun run inspect run <run_id>                    what one run saw, said and did

import { parseArgs } from "node:util";

import { and, asc, desc, eq } from "drizzle-orm";

import { initialState, reduce } from "../core/reducer/index.ts";
import { renderTimeline } from "../core/render/index.ts";
import { createEventStore } from "../core/store/index.ts";
import { type Db, openReadonlyDb, schema } from "../db/index.ts";
import type { LlmRequest, LlmResponse } from "../llm/index.ts";
import { runProcess } from "../process.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { chat: { type: "string" }, n: { type: "string", short: "n", default: "20" } },
});
const [command, target] = positionals;
const out = (line = "") => process.stdout.write(`${line}\n`);

await runProcess("inspect", async ({ config, paths, lc, log }) => {
  const db = openReadonlyDb(paths.database);
  lc.defer("db", () => db.close());
  switch (command) {
    case "chat": {
      if (!target) return usage();
      // Folded from the log without touching snapshots: this database connection is read-only
      const window = { maxItems: config.agent.window.max_items, blockSize: config.agent.window.block_size };
      const state = reduce(initialState(target, window), createEventStore(db, log).read(target, 0));
      out(renderTimeline(state, config));
      return;
    }
    case "runs":
      return listRuns(db, values.chat, Number(values.n));
    case "run":
      return target ? showRun(db, target) : usage();
    default:
      return usage();
  }
});

function usage(): void {
  console.error("Usage: bun run inspect chat <chat_key> | runs [--chat <chat_key>] [-n N] | run <run_id>");
  process.exitCode = 2;
}

function listRuns(db: Db, chat: string | undefined, limit: number): void {
  const runs = db.orm
    .select()
    .from(schema.agentRuns)
    .where(chat ? eq(schema.agentRuns.chat, chat) : undefined)
    .orderBy(desc(schema.agentRuns.startedAt))
    .limit(limit)
    .all();
  for (const run of runs) {
    const took = run.endedAt === null ? "…" : `${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s`;
    out(
      `${run.runId}  ${new Date(run.startedAt).toISOString()}  ${run.status.padEnd(9)} ${took.padStart(7)}  ${run.chat}  ${run.trigger}`,
    );
  }
}

function showRun(db: Db, runId: string): void {
  const run = db.orm.select().from(schema.agentRuns).where(eq(schema.agentRuns.runId, runId)).get();
  if (!run) {
    console.error(`No run ${runId}`);
    process.exitCode = 1;
    return;
  }
  out(`Run ${run.runId} in ${run.chat}, trigger ${run.trigger}, ${run.status}`);
  out(
    `Started ${new Date(run.startedAt).toISOString()}${run.endedAt ? `, ended ${new Date(run.endedAt).toISOString()}` : ""}`,
  );

  const calls = db.orm
    .select()
    .from(schema.llmCalls)
    .where(eq(schema.llmCalls.runId, runId))
    .orderBy(asc(schema.llmCalls.id))
    .all();
  const tools = db.orm
    .select()
    .from(schema.toolCalls)
    .where(and(eq(schema.toolCalls.runId, runId)))
    .orderBy(asc(schema.toolCalls.id))
    .all();

  let toolIndex = 0;
  calls.forEach((call, i) => {
    // Written by createTrace: Robin's request representation, and the response in both forms
    const request = call.request as LlmRequest;
    if (i === 0) {
      section("system");
      out(request.system);
      section("input");
      for (const message of request.messages) {
        if (message.role === "user")
          for (const part of message.parts) if (part.type === "text") out(part.text);
      }
    }
    section(
      `step ${i + 1}: ${call.provider}/${call.model}, ${call.latencyMs ?? "?"} ms, usage ${JSON.stringify(call.usage)}`,
    );
    if (call.error) {
      out(`error: ${call.error}`);
      return;
    }
    const response = (call.response as { ir: LlmResponse }).ir;
    for (const part of response.parts) {
      if (part.type === "text") out(`text (not sent): ${part.text}`);
      if (part.type === "opaque") out(`[${part.provider} opaque block]`);
      if (part.type !== "tool_call") continue;
      const result = tools[toolIndex++];
      out(`→ ${part.name} ${part.arguments}`);
      if (result) out(`  ${result.status}: ${JSON.stringify(result.result)}`);
    }
    out(`stop: ${response.stopReason}`);
  });
}

function section(title: string): void {
  out(`\n── ${title} ${"─".repeat(Math.max(0, 70 - title.length))}`);
}
