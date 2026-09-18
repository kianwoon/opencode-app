# INCLUDE_GLOBAL_CONFIG

## Build / Codegen
- Regenerate legacy JS SDK via `./packages/sdk/js/script/build.ts`.
- `bun run --cwd packages/sdk/js generate` FAILS — `packages/sdk/js/package.json` has no `generate` script (`error: Script not found "generate"`). Run `bun ./script/build.ts` FROM `packages/sdk/js` instead (invokes `@hey-api/openapi-ts`, writes `src/v2/gen`). Note `packages/client`'s `generate` script is a DIFFERENT codegen (`src/generated`/`src/generated-effect`); do not confuse the two. Acceptance gate: a new core-schema field (e.g. `classifier_model`) appears in `packages/sdk/js/src/v2/gen/types.gen.ts`.
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

## Prod build target (CLI vs Desktop App)
- Run `ps aux | grep -i opencode` FIRST to see what the user actually runs; never assume. (Observed: the desktop Electron app at `packages/desktop/dist/mac-arm64/OpenCode.app` running `Resources/app.asar`, not the CLI.)
- CLI binary: `packages/opencode/script/build.ts` → `~/.opencode/bin/opencode`.
- Desktop app: read `packages/desktop/AGENTS.md` before any desktop build — `OPENCODE_CHANNEL=prod bun run build`, then `package:mac`, then `verify-prod.ts`; the app runs `Resources/app.asar` and never loads `~/.opencode/bin`.
- A CLI rebuild does NOT update the desktop app (2026-08-31: hours lost).
- The desktop app's session protocol is detected by `packages/app/src/utils/server-protocol.ts` `detectServerProtocol`, which probes `/global/health` FIRST and returns `"v1"`. The desktop therefore exercises the **v1** turn loop (`packages/opencode/src/session/prompt.ts`), NOT the V2 `packages/core/src/session/runner/llm.ts` loop — decide where agent-loop hooks go accordingly.

## Learnings (MANDATORY)
- After non-obvious rework-causing issues, immediately write concise gotcha + correct command + acceptance gate into relevant package `AGENTS.md` (or root if cross-cutting); repeat mistake = must document.
- Future sessions load `AGENTS.md` automatically; do not rely on memory.
- `context-gate` summarizer must never spawn an LLM helper session when a disk-cached summary exists (pinned-to-fallback window serves fallback text without a flight); cap background summarize flights to 1 per transform. Symptom of violation: a `context-gate summary:` sidebar session per oversize section per LLM loop-step.
- Large-context subagent handoffs can flood the 4MB SSE response cap and abort the task (`SSE stream exceeded 4194304 bytes; the response flooded and was aborted`). Causes seen: a hand told to read a huge file (`~/.local/share/opencode/log/opencode.log` is ~6.7MB — reading it WILL flood); a hand told to read AGENTS.md files that are already auto-injected; repo-wide `git status`/`git diff --stat` on a dirty tree (67 files). Scope handoffs to a few files, demand targeted offset/limit reads, forbid repo-wide diffs, cap the report length, split multi-file work into separate handoffs. Acceptance gate: the hand completes and returns a bounded report instead of aborting.
- Dual-source config footgun (classifier model): one user-visible setting was writable in two unconnected config paths — Settings → Orchestration "Classifier model" writes `brain.classifier_model` (`packages/app/src/components/settings-v2/orchestration.tsx:151`, reusing the generic brain model-row `commit` → `updateConfig({ brain: {...} })`) while the backend shadow hook read top-level `classifier.model` (`packages/opencode/src/session/processor.ts:810`, `packages/opencode/src/classifier/service.ts:111`). Symptom: the toggle opened the gate but the model resolved to `undefined`, so the real transport silently degraded to the deterministic fallback — feature looked configured, never ran, NO error surfaced (the silent no-op is the dangerous part). Fix: resolve through ONE pure helper with explicit precedence — `resolveClassifierModel({ override, brainModel, classifierModel })` → first non-null/non-empty wins, order `override > brain.classifier_model > classifier.model` — used at every read site so precedence lives in exactly one place; empty strings fall through (absent, not a value). Keep `brain.classifier_model` working: it also sets the `classifier` AGENT definition's model (`packages/opencode/src/config/brain.ts:84`). Acceptance gate: a unit test asserting override wins, brain wins over classifier, classifier-only works, all-absent → `undefined`, empty strings fall through — plus the shadow observer skipping entirely when the resolved model is absent.
