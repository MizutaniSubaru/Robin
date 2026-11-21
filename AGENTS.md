# Robin Contributor Guide

Rules for anyone (human or agent) changing Robin. Keep this file short: it records ownership, invariants and conventions.

**Maintenance rule:** update this file in the same change whenever an ownership boundary, invariant or lifecycle rule changes.

## System Overview

Robin is a Telegram bot built on an append-only event log. Two TDLib accounts feed it: a user account that sees groups as a member does, and the bot account that sends. Raw TDLib updates are stored first; the adapter turns them into Robin events, which the store commits in order; a pure core folds the log into per-chat state and renders it for the agent, which talks to an LLM through a provider-neutral representation and speaks only through tools.

## Technology

Bun (runtime, tests, FFI, workers), TypeScript, Biome, SQLite via `bun:sqlite` + Drizzle, Zod, LogTape. TDLib comes from `prebuilt-tdlib` and is loaded with `bun:ffi`. Models through the official SDKs (`@anthropic-ai/sdk`, `openai`).

## Commands

`bun run start` / `dev` / `login` / `probe` / `inspect` / `tdlib:types` / `typecheck` / `lint[:fix]` / `test` / `db:generate` / `db:check`.

`bun run check` (typecheck + lint + tests) is the definition of done.

## Ownership

```text
src/
├── tdlib-api/    Generated TDLib types (td-api.ts from td_api.tl). Neutral: anyone may import
├── sources/      Inputs from the outside world
│   └── tdlib/    FFI, receive worker, hub, clients, accounts, auth, raw update filter and storage,
│                 the ingest (filter -> raw_updates -> adapter), the adapter (updates -> Robin
│                 events), keys, the sender (Robin's messages out)
├── core/
│   ├── events/   Robin's event types (Zod) and dedup keys. Pure
│   ├── reducer/  ChatState (Zod) and reduce(state, events). Pure
│   ├── render/   ChatState -> the XML-like timeline the model reads. Pure
│   ├── markdown/ The model's Markdown -> text + entities. Pure
│   └── store/    The only writer of `events`: ts clock, per-chat inbound queues, aliases, snapshots
├── llm/          Provider-neutral request/response types; one provider per wire protocol (Messages, Chat
│                 Completions, Responses)
├── agent/        Scheduler (when to run), run loop, tools, Pipeline B (self-sender), run traces
├── db/           Drizzle schema, connection, migrations
├── config/       TOML config + environment, validated with Zod
├── log/          LogTape setup
├── cli/          One-shot commands (login, probe, inspect)
├── lifecycle.ts  Ordered cleanup stack
├── process.ts    Process shell: config, logging, signals, fatal, exit code
├── app.ts        Wiring of the long-running app
└── main.ts       Entry point
```

### Dependency Direction

Dependencies point inward. `db/`, `core/` and `tdlib-api/` never import `sources/`, `agent/`, `cli/` or `app.ts`. `core/events`, `core/reducer`, `core/render` and `core/markdown` additionally import nothing but each other and Zod: no I/O, database, config or logging. Both rules are enforced by Biome overrides; do not weaken them to make an import compile, move the code instead.

TDLib-specific concerns (raw update storage, the adapter, chat keys, sending) belong to `sources/tdlib`. Core and agent only ever see Robin events and opaque keys; the agent reaches Telegram through its `Outbound` interface, which `app.ts` fills with the TDLib sender.

## Lifecycle

Every resource registers its cleanup on the `Lifecycle` right after it is acquired; `stop()` undoes them in reverse, so a half-finished startup is undone exactly as far as it got.

Startup order in `app.ts`: open db and migrate -> event store and inbound queues -> raw update writer -> TDLib hub -> accounts (user, then bot; each subscribes before `start()`, the bot's send tracker included) -> recover pending sends -> agent (only with `agent.provider` set). Shutdown is the reverse: runs are aborted and awaited without a time limit (everything a run waits on ends with the abort or its own timeout), accounts close (their last updates are still stored and adapted), the receive worker stops, buffered raw rows flush, queued inbound events commit, the db closes. Logging belongs to the process and shuts down last.

Failures no caller can await (receive loop dead, storage down for good, account gone) go through `ProcessContext.fatal`: log, run the lifecycle, exit 1. Never simulate this with uncaught exceptions or timers.

## Core Invariants

### TDLib Boundary

- `td_receive` runs only in the receive worker; the main thread calls `td_send` / `td_execute`. The worker never calls `td_receive` on two threads at once (the `RECEIVING` slot is a mutex).
- `ffi.ts` `parseTdJson` checks the envelope and the hub's `dispatch` narrows it once; those are the only places TDLib JSON gets a static type. Everywhere else uses `tdlib-api` types; no `as` casts on TDLib data.
- TDLib aborts the process at exit while one of its instances is still open. Accounts close their clients before the hub stops, and `hub.stop()` closes any instance left over; only a dead receive loop may leave one open. A client failing to handle an update is fatal, but receiving goes on so the shutdown can still close the accounts.
- The generated types must match the pinned `prebuilt-tdlib` commit. After an upgrade run `bun run tdlib:types`; a test fails until then. Generated files are gitignored.
- Only server message ids leave the TDLib boundary (`message-id.ts`: TDLib id = server id × 2^20).

### Accounts

The user account owns ingress for groups. The bot sends, runs with privacy mode off, and stores in groups only what the user cannot see (`update-filter.ts`). Both accounts store every non-secret chat's `updateNewChat` and title: the adapter knows chats per account, so a kept update needs its chat introduced in the same account's `raw_updates`. A send returns only after TDLib's `updateMessageSendSucceeded` / `updateMessageSendFailed`.

### Adapter

The adapter is fed exactly what the update filter keeps, which is exactly what `raw_updates` stores, and remembers only what those updates taught it (chat kinds and titles, user names, an edit's pending content). Running it over `raw_updates` again rebuilds the same events, so anything it needs must pass the filter. Served: supergroups through the user account, private chats through the bot. TDLib introduces every user and chat before using it; an unknown one is a bug and throws. The ingest is an isolation boundary: an update the adapter throws on is already headed for `raw_updates`, so it is logged and skipped and a replay recovers it. Storing and committing stay fatal.

### Events and Timestamps

`receivedAt` is wall-clock µs captured in the worker as each item leaves `td_receive`. The store turns it into `ts`: µs, strictly increasing, assigned at commit, so commit order is `ts` order and folding `ts > lastTs` never misses an event. Units: `ts` / `*_ts` / `received_at` µs, `server_date` s, other `*_at` ms.

- Only the store writes `events`, with `eventId` and `ts` assigned there; `UNIQUE(chat, dedup_key)` makes every source event idempotent. Dedup keys come from what identifies an event at the source, never from a platform date: an edit is keyed by the update that carried it, since edit dates have whole seconds.
- Inbound events commit through per-chat queues in arrival order; only the head commits, once its (async) transform is done. Robin's own events (`self.*`) skip the queues and commit synchronously.
- Aliases (`u1`, `u2`, ...) and renames are events the store derives the first time a user is referenced in a chat, never renumbered; the renderer reads nothing but state.
- `reduce` is pure, never mutates its input, trims the window after every event and treats repeats as no-ops, so folding in batches equals folding at once. Snapshots are a cache keyed by `REDUCER_VERSION` and the window; bump the version whenever the same events would fold differently.

### Agent

- Pipeline B: a `self.message` is appended before the platform call; acceptance, confirmation or failure are further `self.send_result` events. Sends have no timeout while running; a send still pending at startup becomes `unknown` and is settled if TDLib finishes it.
- Robin's own events never trigger a run. Runs of one chat never overlap; triggers during a run fold into one follow-up run, skipped when the run already showed them to the model.
- Before every step after the first, a run folds in what happened meanwhile and shows it as an `<update>`; tools check against that newer state.
- Model text is never sent: only `send_message` speaks, `end_turn` ends the turn. Bad tool arguments go back to the model as errors; a failed model call ends the run as failed; anything else is a bug and is fatal.
- Every run is recorded in `agent_runs` / `llm_calls` / `tool_calls` (`bun run inspect`).
- User-controlled text (names, titles, messages) never goes into the system prompt; it reaches the model only through the renderer, escaped.
- Prompt cache breakpoints go only on prefixes the next request repeats unchanged; keep rendered history byte-stable for that.

### Storage

Raw updates leave the write buffer only once committed. A failing write keeps every row and retries with backoff, then calls `fatal`; rows are never dropped to make progress. `events` is append-only.

## Conventions

- Closure factories (`createX(...)` returning an interface), `const`, arrow functions where they read well. `class` only for `Error` subclasses or when a library requires it.
- Let errors propagate. Catch only where the state is still correct afterwards: real recovery (re-prompt on a 400), or isolating a boundary deliberately. Never catch just to log and continue.
- Never invent defaults for invalid or missing data (`?? ""`, `?? 0`, `Number(x)` on unknowns). Fix the type or fail loudly.
- Exhaustive switches over unions; Biome's `useExhaustiveSwitchCases` and `never` checks keep new cases from slipping through.
- `exactOptionalPropertyTypes` is on: `x?: T` means the key may be absent, `x: T | undefined` means it is always set but may be empty. Pick the one that is true.
- Comments record decisions, constraints and evidence. Do not narrate code.
- Kebab-case file names, relative imports with `.ts` extensions, `import type` for types, double quotes, 2 spaces, trailing commas. Biome enforces the rest.
- Logging through LogTape (`getLogger`); `console` only for CLI output.

## Testing

Bun tests under `tests/`, mirroring `src/`. Add a regression test with every bug fix and a characterization test before behavior-preserving restructuring. The TDLib hub, storage and lifecycle are high-risk boundaries.

Use `bun add [-d]`; never hand-edit dependency versions.

## Data Migration

Code handles only the current data shape. Changing stored data needs a new Drizzle migration (`bun run db:generate`); no runtime fallbacks for old shapes.

## Commits

Conventional Commits, focused changes, docs updated in the same commit. Never commit or push without explicit human instruction. Use the contributor's own Git identity; no AI co-author trailers.
