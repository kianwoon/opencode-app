# INCLUDE_GLOBAL_CONFIG

## Build / Codegen
- Regenerate legacy JS SDK via `./packages/sdk/js/script/build.ts`.
- `bun run --cwd packages/sdk/js generate` FAILS — `packages/sdk/js/package.json` has no `generate` script (`error: Script not found "generate"`). Run `bun ./script/build.ts` FROM `packages/sdk/js` instead (invokes `@hey-api/openapi-ts`, writes `src/v2/gen`). Note `packages/client`'s `generate` script is a DIFFERENT codegen (`src/generated`/`src/generated-effect`); do not confuse the two. Acceptance gate: a new core-schema field appears in `packages/sdk/js/src/v2/gen/types.gen.ts` AND any app-side type widening added only to work around the missing field is removed.
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
- One `llm.stream()` per provider turn; reload projected history. The V2 loop is `packages/core/src/session/runner/llm.ts`; the V1 loop `packages/opencode/src/session/prompt.ts` still exists, is what the desktop exercises (see Prod build target), and hosts the workflow DAG plus V1 followup delivery.
- Drains process-local; `SessionRunCoordinator` joins same-session resumes, coalesces wakes, concurrent different sessions; no durable drain identity; post-crash retry needs explicit design.
- Delivery: `steer` (default, promote at next safe boundary) vs `queue` (pending until idle, promote one at a time); any promotion resets agent turn allowance (batch steers = once).
- EventV2 replay owner ≠ execution owner; System Context algebra/registry in `packages/core/src/system-context`; History selection + Epoch persistence Session-owned.

## Prod build target (CLI vs Desktop App)
- Run `ps aux | grep -i opencode` FIRST to see what the user actually runs; never assume. (Observed: the desktop Electron app at `packages/desktop/dist/mac-arm64/OpenCode.app` running `Resources/app.asar`, not the CLI.)
- CLI binary: `packages/opencode/script/build.ts` → `~/.opencode/bin/opencode`.
- Desktop app: read `packages/desktop/AGENTS.md` before any desktop build — `OPENCODE_CHANNEL=prod bun run build`, then `package:mac`, then `verify-prod.ts`; the app runs `Resources/app.asar` and never loads `~/.opencode/bin`.
- A CLI rebuild does NOT update the desktop app.
- The desktop app's session protocol is detected by `packages/app/src/utils/server-protocol.ts` `detectServerProtocol`, which probes `/global/health` FIRST and returns `"v1"` — the desktop exercises the **v1** turn loop (`packages/opencode/src/session/prompt.ts`), NOT the V2 `packages/core/src/session/runner/llm.ts` loop; decide where agent-loop hooks go accordingly.

## Learnings & plugin-lib lessons (read-on-demand; migrated 2026-10-04)
- Standing rule: after non-obvious rework, immediately write gotcha + correct command + acceptance gate into the narrowest layer (owning agent .md → project memory → global MEMORY, read-on-demand). NEVER the global/user AGENTS.md for domain or agent-specific lessons — it auto-injects into every session of every project.
- All project lessons + acceptance gates (SDK codegen, config-schema drift, classifier/permission footguns, context-gate round-trip, plugin-lib loading, V1 guard, tool-registry exposure, config-injection contract) now live in `./.opencode/MEMORY/2026-10-04-agents-learnings-migrated.md` — READ IT before build/config/plugin/permission work in this repo.
- NEW lessons go to `./.opencode/MEMORY/` (project-local), NOT back into this file: this file rides EVERY LLM request as injected context — every KB here is a per-request token tax (measured 2026-10-04: ~18k tok/turn tail re-bill; the advisory scales with this file's size).
