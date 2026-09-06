# INCLUDE_GLOBAL_CONFIG

## Build / Codegen
- Regenerate legacy JS SDK via `./packages/sdk/js/script/build.ts`.
- After Protocol/Server `HttpApi` change: `bun run generate` from `packages/client`; never edit `src/generated` / `src/generated-effect`.

## Dependencies
- `schema → core, protocol → server`
- `client → schema, protocol` (never core/server)
- `sdk-next → client, core, server`


## Style
- One function unless composable/reusable; no preemptive single-use helpers; inline single-use values.
- No `try/catch` where possible; no `any`; use Bun APIs (`Bun.file()`); rely on inference.
- Prefer `map/filter/flatMap` + type guards over loops.
- `src/config`: self-export pattern (`export * as ConfigAgent from "./agent"`).
- Effect generators: bind services to named vars; no `yield* (yield* Foo.Service).bar()`.
- No unnecessary destructuring (use `obj.a`); no import aliases; no star imports.
- Namespace by name: `import { Project } ...`, use `Project.ID`.
- Dynamic imports for heavy/path-specific modules, destructured at top of narrowest scope; no `.then` chains; keep branch imports in-branch.
- `const` over `let`; ternaries/early returns; no `else`.
- Complex logic: main fn = happy path, helpers below; only extract real concepts.
- Helpers don't return `Effect` unless effectful; keep sync parsing/validation sync.
- Prefer `Schema.UnknownFromJsonString` / `Schema.decodeUnknownOption` over `JSON.parse`+`Effect.try`.
- Comment only non-obvious constraints.
- Drizzle: `snake_case` fields so columns need no string rename.

## Testing
- No mocks; no `globalThis.*` unless only option; test real impl, don't duplicate logic.
- Never run tests from repo root; run from package dirs (e.g. `packages/opencode`).

## Typecheck
- `bun typecheck` from package dir, never `tsc` directly.

## V2 Session Core (`packages/core` + `packages/opencode`)
- `SessionV2.prompt()` = admit 1 durable `session_input` row + advisory `SessionExecution.wake()` unless `resume:false` (admit-only); runner promotes at safe boundaries.
- Session ID reuse adopts session; prompt ID reuse = exact retry only if session+prompt+delivery match.
- `SessionExecution` process-global, Session-ID based; placement via `SessionStore`+`LocationServiceMap` only at drain start; interruption = active local chain, idle = no-op.
- `SessionRunner`/models/tools/permissions/filesystem are Location-scoped; omitted workspace = implicit-local.
- One `llm.stream()` per provider turn; reload projected history; no legacy `SessionPrompt.loop`.
- Drains process-local; `SessionRunCoordinator` joins same-session resumes, coalesces wakes, concurrent different sessions; no durable drain identity; post-crash retry needs explicit design.
- Delivery: `steer` (default, promote at next safe boundary) vs `queue` (pending until idle, promote one at a time); any promotion resets agent turn allowance (batch steers = once).
- EventV2 replay owner ≠ execution owner; System Context algebra/registry in `packages/core/src/system-context`; History selection + Epoch persistence Session-owned.

## Learnings (MANDATORY)
- After non-obvious rework-causing issues, immediately write concise gotcha + correct command + acceptance gate into relevant package `AGENTS.md` (or root if cross-cutting); repeat mistake = must document.
- Future sessions load `AGENTS.md` automatically; do not rely on memory.
