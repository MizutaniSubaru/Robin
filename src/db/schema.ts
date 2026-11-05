// Time units: ts / *_ts / received_at are microseconds, server_date is seconds,
// other *_at columns are milliseconds.
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

type JsonObject = Record<string, unknown>;

const nowMs = () => Date.now();

// Append-only event log, the source of truth
export const events = sqliteTable(
  "events",
  {
    // Physical row id, only used as a tie-breaker when ts is equal
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull().unique(),
    // Monotonic timestamp assigned at commit, the ordering key
    ts: integer("ts").notNull(),
    tsSource: text("ts_source", { enum: ["local", "server"] }).notNull(),
    // Original Telegram date, if any
    serverDate: integer("server_date"),
    chat: text("chat").notNull(),
    kind: text("kind").notNull(),
    // Event schema version
    v: integer("v").notNull().default(1),
    account: text("account").notNull(),
    // Idempotency key; NULL means no dedup
    dedupKey: text("dedup_key"),
    payload: text("payload", { mode: "json" }).$type<JsonObject>().notNull(),
  },
  (t) => [
    uniqueIndex("events_chat_dedup_key_uq").on(t.chat, t.dedupKey),
    index("events_chat_ts_idx").on(t.chat, t.ts, t.id),
  ],
);

// Raw TDLib updates the adapter needs, for debugging and for re-running it over old data.
// Filtered on the way in (createUpdateFilter); no retention period until the event schema settles
export const rawUpdates = sqliteTable(
  "raw_updates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    account: text("account").notNull(),
    // TDLib @type, e.g. updateNewMessage
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<JsonObject>().notNull(),
    receivedAt: integer("received_at").notNull(),
  },
  (t) => [index("raw_updates_received_at_idx").on(t.receivedAt)],
);

// Reducer checkpoints
export const chatSnapshots = sqliteTable("chat_snapshots", {
  chat: text("chat").primaryKey(),
  lastTs: integer("last_ts").notNull(),
  // Snapshot is discarded when this doesn't match the current reducer
  reducerVersion: integer("reducer_version").notNull(),
  state: text("state", { mode: "json" }).$type<JsonObject>().notNull(),
  updatedAt: integer("updated_at").notNull().$defaultFn(nowMs),
});

export const chats = sqliteTable("chats", {
  chat: text("chat").primaryKey(),
  type: text("type", { enum: ["private", "basic_group", "supergroup"] }).notNull(),
  title: text("title"),
  // Account that receives inbound updates for this chat
  inboundAccount: text("inbound_account").notNull(),
});

// User profile cache
export const users = sqliteTable("users", {
  user: text("user").primaryKey(),
  displayName: text("display_name").notNull(),
  username: text("username"),
  isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull().$defaultFn(nowMs),
});

// Downloaded media files
export const files = sqliteTable(
  "files",
  {
    fileKey: text("file_key").primaryKey(),
    localPath: text("local_path").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
  },
  (t) => [index("files_sha256_idx").on(t.sha256)],
);

// Cached image / sticker descriptions.
// desc_key is thumb:<hash>, sha256:<hex> or emoji:<custom_emoji_id>
export const mediaDescriptions = sqliteTable("media_descriptions", {
  descKey: text("desc_key").primaryKey(),
  description: text("description").notNull(),
  model: text("model").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(nowMs),
});

// Stickers the bot can send
export const stickers = sqliteTable(
  "stickers",
  {
    fileKey: text("file_key").primaryKey(),
    setName: text("set_name"),
    emoji: text("emoji"),
    format: text("format", { enum: ["webp", "tgs", "webm"] }).notNull(),
    // remote_id usable by the bot account, NULL until resolved
    sendableRemoteId: text("sendable_remote_id"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("stickers_emoji_idx").on(t.emoji)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    runId: text("run_id").primaryKey(),
    chat: text("chat").notNull(),
    trigger: text("trigger").notNull(),
    // Range of events covered by this run
    fromTs: integer("from_ts"),
    toTs: integer("to_ts"),
    status: text("status", { enum: ["running", "completed", "failed", "aborted"] })
      .notNull()
      .default("running"),
    startedAt: integer("started_at").notNull().$defaultFn(nowMs),
    endedAt: integer("ended_at"),
  },
  (t) => [index("agent_runs_chat_started_at_idx").on(t.chat, t.startedAt)],
);

// Full LLM requests and responses
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.runId),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    request: text("request", { mode: "json" }).$type<unknown>().notNull(),
    response: text("response", { mode: "json" }).$type<unknown>(),
    usage: text("usage", { mode: "json" }).$type<JsonObject>(),
    latencyMs: integer("latency_ms"),
    error: text("error"),
  },
  (t) => [index("llm_calls_run_id_idx").on(t.runId)],
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.runId),
    name: text("name").notNull(),
    // Raw arguments from the model, may be invalid
    args: text("args", { mode: "json" }).$type<unknown>().notNull(),
    result: text("result", { mode: "json" }).$type<unknown>(),
    status: text("status", { enum: ["ok", "error", "invalid_args"] }).notNull(),
  },
  (t) => [index("tool_calls_run_id_idx").on(t.runId)],
);
