import type { EventStore, Projection } from "../core/store/index.ts";
import type { Db } from "../db/index.ts";
import type { LlmProvider } from "../llm/index.ts";
import type { Logger } from "../log/index.ts";
import { type RunOptions, runChat } from "./run.ts";
import { createScheduler, type Scheduler, type SchedulerOptions } from "./scheduler.ts";
import type { SelfSender } from "./self-sender.ts";
import { createTrace } from "./trace.ts";

export { type RunDeps, type RunOptions, runChat, type Trigger } from "./run.ts";
export { createScheduler, type Scheduler } from "./scheduler.ts";
export {
  createSelfSender,
  type FormattedText,
  type Outbound,
  type SelfSender,
  type SendOutcome,
} from "./self-sender.ts";
export { toolSpecs } from "./tools.ts";
export { createTrace, type Trace } from "./trace.ts";

export interface AgentSetup {
  db: Db;
  store: EventStore;
  projection: Projection;
  provider: LlmProvider;
  sender: SelfSender;
  options: RunOptions;
  allowedChats: readonly string[];
  self: SchedulerOptions["self"];
  privateDebounceMs: number;
  onFatal(error: Error): void;
  log: Logger;
}

// Listens for triggering events and runs the model on them
export function startAgent(setup: AgentSetup): Scheduler {
  const deps = {
    store: setup.store,
    projection: setup.projection,
    provider: setup.provider,
    sender: setup.sender,
    trace: createTrace(setup.db),
    log: setup.log,
    options: setup.options,
  };
  return createScheduler(setup.store, {
    allowedChats: setup.allowedChats,
    self: setup.self,
    privateDebounceMs: setup.privateDebounceMs,
    run: (chat, trigger, signal) => runChat(deps, chat, trigger, signal),
    onFatal: setup.onFatal,
    log: setup.log,
  });
}
