# Robin Contributor Guide

Rules for anyone (human or agent) changing Robin. Keep this file short: it records ownership, invariants and conventions. Rationale and long-term design live in focused documents under `docs/`.

**Maintenance rule:** update this file in the same change whenever an ownership boundary, invariant or lifecycle rule changes.

## System Overview

Robin is a Telegram bot built on an append-only event log. Two TDLib accounts feed it: a user account that sees groups as a member does, and the bot account that sends. Raw TDLib updates are stored first; adapters turn them into Robin events; a pure core reduces and renders those events for the agent.

## Technology

Bun (runtime, tests, FFI, workers), TypeScript, Biome, SQLite via `bun:sqlite` + Drizzle, Zod, LogTape. TDLib comes from `prebuilt-tdlib` and is loaded with `bun:ffi`.

## Commands

`bun run start` / `dev` / `login` / `probe` / `tdlib:types` / `typecheck` / `lint[:fix]` / `test` / `db:generate` / `db:check`.

`bun run check` (typecheck + lint + tests) is the definition of done.

## Ownership

```text
src/
├── tdlib-api/    Generated TDLib types (td-api.ts from td_api.tl). Neutral: anyone may import
├── sources/      Inputs from the outside world
│   └── tdlib/    FFI, receive worker, hub, clients, accounts, auth, raw update filter and storage
├── core/         Robin's own events, reducer and renderer. Pure (see below)
├── db/           Drizzle schema, connection, migrations
├── config/       TOML config + environment, validated with Zod
├── log/          LogTape setup
├── cli/          One-shot commands (login, probe)
├── lifecycle.ts  Ordered cleanup stack
├── process.ts    Process shell: config, logging, signals, fatal, exit code
├── app.ts        Wiring of the long-running app
└── main.ts       Entry point
```

### Dependency Direction

Dependencies point inward. `db/`, `core/` and `tdlib-api/` never import `sources/`, `cli/` or `app.ts`. `core/events`, `core/reducer` and `core/render` additionally import nothing but each other and Zod: no I/O, database, config or logging. Both rules are enforced by Biome overrides; do not weaken them to make an import compile, move the code instead.

TDLib-specific concerns (raw update storage included) belong to `sources/tdlib`. Core only ever sees Robin events.

## Lifecycle

Every resource registers its cleanup on the `Lifecycle` right after it is acquired; `stop()` undoes them in reverse, so a half-finished startup is undone exactly as far as it got.

Startup order in `app.ts`: open db and migrate -> raw update writer -> TDLib hub -> accounts (user, then bot; each subscribes before `start()`). Shutdown is the reverse: accounts close (their last updates are still stored), the receive worker stops, buffered rows flush, the db closes. Logging belongs to the process and shuts down last.

Failures no caller can await (receive loop dead, storage down for good, account gone) go through `ProcessContext.fatal`: log, run the lifecycle, exit 1. Never simulate this with uncaught exceptions or timers.

## Core Invariants

### TDLib Boundary

- `td_receive` runs only in the receive worker; the main thread calls `td_send` / `td_execute`. The worker never calls `td_receive` on two threads at once (the `RECEIVING` slot is a mutex).
- `ffi.ts` `parseTdJson` is the only place TDLib JSON gets a static type. Everywhere else uses `tdlib-api` types; no `as` casts on TDLib data.
- The generated types must match the pinned `prebuilt-tdlib` commit. After an upgrade run `bun run tdlib:types`; a test fails until then. Generated files are gitignored.
- Only server message ids leave the TDLib boundary (`message-id.ts`: TDLib id = server id × 2^20).

### Accounts

The user account owns ingress for groups. The bot sends, runs with privacy mode off, and stores in groups only what the user cannot see (`update-filter.ts`). A send returns only after TDLib's `updateMessageSendSucceeded` / `updateMessageSendFailed`.

### Timestamps

`receivedAt` is wall-clock µs captured in the worker as each item leaves `td_receive`; it is the ordering source of truth. Units: `ts` / `*_ts` / `received_at` µs, `server_date` s, other `*_at` ms.

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

`docs/private/` is local-only and gitignored. Shareable docs go directly under `docs/`.
