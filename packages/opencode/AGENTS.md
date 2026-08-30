# opencode database guide

## Provider `options.timeout` is an IDLE timeout, not a whole-request deadline

- `provider.<id>.options.timeout` in opencode.json used to be wired as `AbortSignal.timeout(ms)`
  in src/provider/provider.ts — an UNCANCELLABLE whole-request timer that killed healthy
  streaming responses mid-turn at exactly N seconds while chunks were still flowing (observed:
  `timeout: 300000` on zai-coding-plan aborted every GLM reasoning turn longer than 5 minutes,
  9+ times over 3 days). Because the resulting AbortError maps to `AbortedError`, it looks
  exactly like a user cancel and is easy to misdiagnose as infra flakiness.
- It is now IDLE-based: it guards the headers phase and, unless explicit `chunkTimeout` /
  `headerTimeout` override it, gaps between SSE chunks. Explicit phase timeouts always win
  for their phase. NEVER reintroduce a hard total-time timeout on provider fetch — long
  reasoning turns legitimately run for many minutes.
- **Default ON (2026-08-30)**: when no timeout options are configured, `DEFAULT_IDLE_TIMEOUT`
  (180s) applies to BOTH phases via `resolveIdleTimeouts` — so a provider stream that goes
  silently silent mid-turn (observed: z.ai GLM gateway parked silent-canyon 15 minutes with
  zero log lines) is aborted and retried instead of hanging until manual cancel. Escape
  hatches, per phase: `timeout: false` (both), `chunkTimeout: false` (chunk guard only),
  `headerTimeout: false` (headers guard only).
- Stalls raise `ProviderError.ChunkStallError` (subclass of `ResponseStreamError`, carries
  `ms`), mapped to a RETRYABLE `APIError` with `metadata.code = "ProviderChunkStallError"`
  in `MessageV2.fromError` — bounded by the normal retry schedule (5 attempts, backoff).
  The AI SDK `onError` handler in src/session/llm.ts logs stalls as WARN (not ERROR) with
  `stallIdleMs`. `console.warn` does NOT reach opencode.log — only Effect loggers do.
- Diagnostic: pair `message=process ... messageID=X` log lines (start vs error timestamps);
  an exact repeated delta across aborts = a config/code timer, not infra.
- Acceptance guard: test/provider/header-timeout.test.ts ("timeout does not abort a healthy
  SSE stream mid-body", "timeout aborts when response headers never arrive", "timeout acts
  as idle guard between SSE chunks", "timeout: false disables the default idle guard") +
  test/provider/idle-timeout.test.ts (resolver defaults and escape hatches).

## Idle-GC hook (Bun) — remove when Bun ships oven-sh/bun#36638

- `SessionStatus` (src/session/status.ts) schedules one non-blocking `Bun.gc(false)` via a
  5s debounce when the LAST busy session goes idle; any busy transition cancels the timer.
  This mimics Bun's upstream idle-GC work (oven-sh/bun#36638, open at time of writing) that
  halved Claude Code's p99 CPU — Bun's stock GC fires on allocation/timer thresholds and
  lands mid-turn.
- Bun-only by runtime check (`typeof Bun === "undefined"`); the Node desktop sidecar is
  unaffected (V8 GC is already mutator-aware).
- When Bun releases an idle-driven GC controller, delete the `onIdle` closure from the
  `InstanceState.make` body in status.ts, bump `packageManager` in the root package.json,
  and rebuild the compiled binary (script/build.ts). Acceptance guard:
  test/session/status-gc.test.ts.

## Session auto-title gotchas

- `SessionPrompt.ensureTitle` (src/session/prompt.ts) is forked on the FIRST iteration of every
  prompt loop while the session title is still the default (`Session.isDefaultTitle`). It derives
  the title from the first real user message, NOT just the session's first prompt — a failed
  title-model call (provider down, empty/thinking-only output) retries on the next prompt instead
  of leaving the session permanently "New session - ...".
- Title failures are logged (`failed to generate title` / `title model returned no usable text`),
  never thrown: the stream pipeline converts failures to warnings and the fork keeps
  `Effect.ignore` as a safety net. Do NOT reintroduce `Effect.orDie` there — combined with the
  fork's `Effect.ignore` it swallowed every failure silently (that is why broken self-hosted
  providers used to leave sessions untitled with zero log evidence).
- To script title requests in e2e tests, use `pushMatch(titleMatch, ...)` from
  test/lib/llm-server.ts; unmatched title requests are auto-answered with "E2E Title" and never
  consume plain queued items. Acceptance guard: test/session/prompt.test.ts
  "auto title retries on a later prompt after the first title generation fails".

## Degenerate repetition-loop guard

- Some models (notably behind aggregator/proxy providers like B.AI) can enter a state where
  they stream the same sentence forever ("Let me commit. Let me commit. ...") without ever
  finishing the turn or calling a tool. The provider never emits a stop token, so the session
  hangs until the user aborts manually.
- `src/session/llm/repetition-guard.ts` scans `text-delta` LLM events for consecutive
  repetition of the same sentence (default: 3+ repeats of a ≥12-char sentence) and fails the
  stream with a **non-retryable** `MessageError.RepetitionLoopError`. It is applied in
  `LLM.Service.stream` (`src/session/llm.ts`) to BOTH the native and AI SDK runtimes.
- The guard only watches user-visible text deltas, not reasoning/tool-input deltas, and
  ignores short fragments ("ok.", "yes") that legitimately repeat.
- `MessageV2.fromError` maps `RepetitionLoopError` to an `APIError` with
  `isRetryable: false` and `metadata.code = "repetition_loop"`, so the retry policy does not
  re-run a degenerate generation. Do NOT make this retryable.
- Prevention: configure `frequency_penalty` / `presence_penalty` on the provider's models
  (`provider.<id>.models.<model>.options`). For OpenAI-compatible providers these reach the
  request body via `providerOptions["<provider-id>"]` (see `ProviderTransform.providerOptions`
  dot-split key resolution). Acceptance guard: test/session/repetition-guard.test.ts.

## Config reload gotchas

- "Reload configs" (global dispose, SIGUSR2, config-update) drops the TTL-infinity global
  config cache and disposes every instance; the next instance access re-bootstraps from disk.
- Bun caches dynamic `import()` by URL, and `file://` URLs with a query string STILL hit that
  cache — only a bare path + query busts it. `PluginLoader.load` therefore suffixes file
  plugin entries with `?mtime=<ms>` (via `bustFileEntry`) so edited plugin code re-evaluates
  across reloads. npm plugin entries keep their stable URL (their versioned install dir
  already changes on update). Acceptance guard: test/plugin/loader-shared.test.ts
  "re-evaluates edited file plugin code across instance reload".

## Plugin loader must be Node-compatible (desktop sidecar)

- The desktop app runs its server as a **Node.js sidecar**
  (`utilityProcess.fork` of `sidecar.js`), NOT on Bun. The CLI runs on Bun.
  Any plugin-loading path that touches a Bun-only global (`Bun.file`, `Bun.$`, …)
  crashes the sidecar with `ReferenceError: Bun is undefined`.
- `PluginLoader.bustFileEntry` used `Bun.file(file).stat()` — so in the app **every
  file-based plugin silently failed to load** while the CLI loaded them fine. The
  failure is published as a **session error event (TUI toast), never a log line**,
  so `opencode.log` showed nothing and the regression stayed hidden.
- Rule: plugin load/resolve paths must use `node:fs/promises` (or other Node APIs),
  never `Bun.*`. Acceptance guard: `bun test test/plugin/loader-shared.test.ts` +
  a manual sidecar smoke test (the CLI alone cannot catch this — it runs on Bun).

## Workflow/DAG engine gotchas

- The `workflow` tool executes inside the session loop's own tool pass. It must admit its
  `WorkflowPart` with `noReply: true` via `ops.prompt(...)`; calling with a loop would wait
  on the run it is already inside (`Runner.ensureRunning` joins the current run) and
  deadlock the session. The next loop iteration dispatches the part from the task queue.
- `runSubagentTask` (shared by `subtask` parts and workflow steps) must never throw after
  creating its tool part without settling the part as an error AND completing the assistant
  message. A settled assistant message after the task part is also the task-consumption
  boundary in `MessageV2.latest()`; without it the same task part is re-collected and
  re-dispatched forever.
- Workflow step outcomes are recorded in scheduler state (`record`), never thrown: failure
  is a scheduling outcome. Failure reasons (NamedError: read `.data.message`, plain Error:
  `.message`) go into the synthetic summary so the orchestrating model can react.
- Scheduling is event-driven (per-step fibers, `Effect.raceAll` over `Fiber.await`) with a
  concurrency cap from `experimental.workflow_concurrency` (default 4). Do not reintroduce
  batch-barrier scheduling (`Effect.all` per ready wave) — it delays unrelated dependents.
- Step fibers must be forked with `Effect.forkChild`, never `Effect.forkIn(scope)`. The
  instance `scope` is a daemon scope: forking steps there detaches them from the loop
  fiber, so `prompt.cancel` interrupts the loop but leaves in-flight steps running to
  completion — burning model turns, mutating the tree, and leaving their tool parts stuck
  `"running"` forever. As children, steps inherit the loop's interrupt and cascade it into
  the task tool's own `onInterrupt`, which settles the part and aborts the child session.
- Workflow admission (graph shape + `MAX_WORKFLOW_STEPS` cap) lives in
  `src/session/workflow/dag.ts` (`validateWorkflow`). Both the model-facing tool AND the
  loop dispatcher must enforce it — the HTTP `PromptPayload` accepts `WorkflowPartInput`
  directly, so without the dispatch-side check a direct API caller bypasses the tool's cap.
  Acceptance gate: `test/session/prompt.test.ts` "direct API workflow part over the step
  cap is rejected at dispatch".
- `validateDag` cycle detection is iterative (explicit DFS stack) on purpose: a long
  dependency chain (10k+ steps) would overflow the call stack with recursion. Keep it
  iterative; the 50k-step deep-chain test in `test/session/workflow/dag.test.ts` is the
  regression guard.
- When mocking LLM failures in workflow e2e tests, `llm.fail("...")` stream errors are
  often consumed by session retry (message patterns like "rate limit" match
  `RETRYABLE_MESSAGE_PATTERNS` in `src/session/retry.ts`, 2s backoff). Use
  `llm.error(400, {message})` for non-retryable provider failures.

## Database

- **Schema**: Drizzle schema lives in `packages/core/src/**/*.sql.ts`.
- **Migrations**: database migrations live in `packages/core` and are applied by core.

## Unsupported attachment fallback

- `unsupportedParts` in `src/provider/transform.ts` handles media the selected model cannot accept (e.g. pasted screenshots on text-only models). It must NOT discard the bytes: write them to `<tmpdir>/opencode/<sha256-prefix><ext>` (content-hash naming keeps repeated provider turns idempotent) and replace the part with a text note carrying the absolute path so the model can inspect the file with a suitable tool.
- The write stays synchronous (`writeFileSync`) on purpose: `ProviderTransform.message()` is called from the sync `nativeRuntime.stream()` path and the AI SDK `transformParams` middleware — do not make it async without redesigning those call sites.
- If the write fails, fall back to the old `ERROR: Cannot read ...` text; never fail the provider call over tmp cleanup. Acceptance guard: `test/provider/transform.test.ts` "saves unsupported image bytes to a temp file and references the path".

## Development server

- Running `bun dev` from `packages/opencode` starts the live interactive TUI. Do not run it as a blocking foreground command when you need to inspect the result.
- Start it in `tmux` instead: `tmux new-session -d -s opencode-dev 'bun dev'`.
- Capture the current TUI output with: `tmux capture-pane -pt opencode-dev`.
- Stop the session explicitly when done: `tmux kill-session -t opencode-dev`.

# Module shape

Do not use `export namespace Foo { ... }` for module organization. It is not
standard ESM, it prevents tree-shaking, and it breaks Node's native TypeScript
runner. Use flat top-level exports combined with a self-reexport at the bottom
of the file:

```ts
// src/foo/foo.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
export const layer = Layer.effect(Service, ...)
export const defaultLayer = layer.pipe(...)

export * as Foo from "./foo"
```

Consumers import the namespace projection:

```ts
import { Foo } from "@/foo/foo"

yield * Foo.Service
Foo.layer
Foo.defaultLayer
```

Namespace-private helpers stay as non-exported top-level declarations in the
same file — they remain inaccessible to consumers (they are not projected by
`export * as`) but are usable by the file's own code.

## When the file is an `index.ts`

If the module is `foo/index.ts` (single-namespace directory), use `"."` for
the self-reexport source rather than `"./index"`:

```ts
// src/foo/index.ts
export const thing = ...

export * as Foo from "."
```

## Multi-sibling directories

For directories with several independent modules (e.g. `src/session/`,
`src/config/`), keep each sibling as its own file with its own self-reexport,
and do not add a barrel `index.ts`. Consumers import the specific sibling:

```ts
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
```

Barrels in multi-sibling directories force every import through the barrel to
evaluate every sibling, which defeats tree-shaking and slows module load.

# opencode Effect rules

Use these rules when writing or migrating Effect code.

See `specs/effect/migration.md` for the compact pattern reference and examples.

## Core

- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` for named/traced effects and `Effect.fnUntraced` for internal helpers.
- `Effect.fn` / `Effect.fnUntraced` accept pipeable operators as extra arguments, so avoid unnecessary outer `.pipe()` wrappers.
- Use `Effect.callback` for callback-based APIs.
- Use `Effect.void` instead of `Effect.succeed(undefined)` or `Effect.succeed(void 0)`.
- Prefer `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)` when you need a `Date`.

## Module conventions

- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

## Schemas and errors

- Use `Schema.Class` for multi-field data.
- Use branded schemas (`Schema.brand`) for single-value types.
- Use `Schema.TaggedErrorClass` for typed errors.
- Use `Schema.Defect` instead of `unknown` for defect-like causes.
- In `Effect.gen` / `Effect.fn`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))` for direct early-failure branches.

## Runtime vs InstanceState

- Use `makeRuntime` (from `src/effect/run-service.ts`) for all services. It returns `{ runPromise, runFork, runCallback }` backed by a shared `memoMap` that deduplicates layers.
- Use `InstanceState` (from `src/effect/instance-state.ts`) for per-directory or per-project state that needs per-instance cleanup. It uses `ScopedCache` keyed by directory — each open project gets its own state, automatically cleaned up on disposal.
- If two open directories should not share one copy of the service, it needs `InstanceState`.
- Do the work directly in the `InstanceState.make` closure — `ScopedCache` handles run-once semantics. Don't add fibers, `ensure()` callbacks, or `started` flags on top.
- Use `Effect.addFinalizer` or `Effect.acquireRelease` inside the `InstanceState.make` closure for cleanup (subscriptions, process teardown, etc.).
- Use `Effect.forkScoped` inside the closure for background stream consumers — the fiber is interrupted when the instance is disposed.
- To make a service's `init()` non-blocking, fork `InstanceState.get(state)` at the `init()` call site (e.g. `Effect.forkIn(scope)`), not by forking work inside the `InstanceState.make` closure. Forking inside the closure leaves state incomplete for other methods that read it.
- `src/project/bootstrap.ts` already wraps every service `init()` in `Effect.forkDetach`, so `init()` is fire-and-forget in production. Keep `init()` methods synchronous internally; the caller controls concurrency.

## Effect v4 beta API

- `Effect.fork` and `Effect.forkDaemon` do not exist. Use `Effect.forkIn(scope)` to fork a fiber into a specific scope.

## Preferred Effect services

- In effectified services, prefer yielding existing Effect services over dropping down to ad hoc platform APIs.
- Prefer `FileSystem.FileSystem` instead of raw `fs/promises` for effectful file I/O.
- Prefer `ChildProcessSpawner.ChildProcessSpawner` with `ChildProcess.make(...)` instead of custom process wrappers.
- Prefer `HttpClient.HttpClient` instead of raw `fetch`.
- Prefer `Path.Path`, `Config`, `Clock`, and `DateTime` when those concerns are already inside Effect code.
- For background loops or scheduled tasks, use `Effect.repeat` or `Effect.schedule` with `Effect.forkScoped` in the layer definition.

## Effect.cached for deduplication

Use `Effect.cached` when multiple concurrent callers should share a single in-flight computation rather than storing `Fiber | undefined` or `Promise | undefined` manually. See `specs/effect/migration.md` for the full pattern.

## Callback boundaries

Use `EffectBridge` for native or external callbacks (`@parcel/watcher`, `node-pty`, native `fs.watch`, plugin callbacks, etc.) that need to re-enter Effect services with instance/workspace context.

Plain async code should pass explicit context or stay inside an Effect fiber; do not add ambient instance context shims.
