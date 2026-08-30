# OpenCode Harness Enhancement Roadmap

Enhance OpenCode's native agent harness instead of integrating external
engines. The harness already has a solid core (agent loop, Runner, compaction,
plan mode, background jobs, subagents, permissions, SQLite persistence). This
roadmap closes the gaps that matter most, phased by leverage vs. risk.

> **Target: the v1 harness.** All phases target the live path — the server's
> prompt handler (`handlers/session.ts`) calls `SessionPrompt.Service`
> (`src/session/prompt.ts`, the v1 loop). The V2 Session Core exists in the
> tree but is not what the running app wires to. Enhancements are v1-first with
> a v2 carry-forward noted per phase.

## Current strengths (keep, don't rebuild)

- Agent loop: `SessionPrompt.runLoop` + `Runner` (`src/effect/runner.ts`)
- Compaction: `src/session/compaction.ts`
- Plan mode: `src/tool/plan.ts`
- Background jobs: `src/background/job.ts`
- Subagents: `task` tool + `subagent-permissions.ts`
- Tool output truncation: `src/tool/truncate.ts`
- Permissions, model adapters, SQLite session store

## Gap analysis

| Capability          | OpenCode today                                                                                                                         | dsh had                         | Value                     | Risk                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------- | ------------------- |
| Token metering      | ✅ Already implemented (session.ts computes input/output/reasoning/cache breakdown + cost from model pricing; persisted + shown in UI) | `token-meter`                   | —                         | —                   |
| Tool-result pruning | Core: static `Truncate` (line/byte → file). User plugin: smart pruning (relevance, summaries, cache-aware) via transform hooks         | `compaction-tool-result-pruner` | High (context protection) | Low-Med             |
| Sandboxing          | None beyond shell cwd (no container/OS isolation)                                                                                      | `sandbox-local`, `e2b`          | High (safety)             | High (biggest lift) |
| Workflow/DAG        | None                                                                                                                                   | `dsh-workflow`                  | Med-High                  | Med                 |
| Scheduling          | Background jobs (adequate)                                                                                                             | `dsh-schedule`                  | Marginal                  | —                   |

## Phased plan

### Phase 1 — Harden core for context-optimizer-style pruning (leverage: high, risk: low-med)

- **Verified reality:** smart pruning already exists as the user's `context-optimizer` plugin (`~/.config/opencode/plugins/context-optimizer.ts`, ~76KB) — it prunes tool outputs (head+tail summaries), old assistant text, reasoning parts, redundant turns, with budget/cache-prefix protection, token estimation + calibration. It hooks via `experimental.chat.messages.transform` + `experimental.chat.system.transform`.
- The core only has static `Truncate` (line/byte cuts → saved file). The plugin is _more_ advanced.
- **The real gap:** the plugin works around missing core APIs (its own comments: "the plugin API has NO part-update endpoint", tool schemas not exposed on the transform hook).
- **What to build:** expose the missing core APIs the plugin needs — a part-update endpoint/event and tool-schema access in the transform hook — and/or port the optimizer into `packages/opencode/src/` so it's first-class for the whole team, not just this machine.
- Acceptance: the optimizer's behavior works via core APIs (no plugin workarounds), available to any agent without the plugin file.

> Token metering was considered but **dropped**: OpenCode already implements per-call token breakdown (input/output/reasoning/cache) and cost from model pricing tiers in `session.ts`, persisted to the session row and displayed in the UI. No gap to close.

### Phase 2 — Sandboxing (leverage: high, risk: high)

- Add a `Sandbox` capability seam on the shell tool: an optional container/runtime backend (e.g. e2b, Firecracker, or a local container) that executes bash in an isolated environment.
- Keep the current direct-shell path as the default; sandbox is opt-in per agent/permission.
- Wire the existing permission system (`bash: ask/allow/deny`) to the sandbox policy.
- Acceptance: `bash` in a sandboxed agent cannot write outside its workspace root; a "sandbox escape" test fails closed.

### Phase 3 — Workflow/DAG engine (leverage: med-high, risk: med)

**Targets the v1 harness** (the live path: server `handlers/session.ts` → `SessionPrompt.Service` → `prompt.ts`). All hooks verified in the v1 code.

**Verified foundations (evidence in code):**

- Task dispatch queue exists in the v1 loop: `MessageV2.latest(msgs)` (prompt.ts:1096) collects pending `subtask`/`compaction` parts → `tasks.pop()` (prompt.ts:1142) dispatches them.
- Subtask execution pattern exists: `handleSubtask` (prompt.ts:255) runs each subtask via the task tool. A workflow step reuses this.
- `SubtaskPart` schema (schema/src/v1/session.ts:204) has `prompt/description/agent/model/command` — **no `depends` field**.
- Background jobs (`core/src/background-job.ts`): `StartInput` has `id/type/title/metadata/onPromote/run` — **no dependency field**.
- Tool emission seam: `SessionPrompt.command` (prompt.ts:1464-1468) emits `type: "subtask"` parts; a `workflow` part would follow the same path.

**What to build (Option C — model + declarative):**

- Add a `WorkflowPart` schema (new part type, sibling of `SubtaskPart`) with `steps: [{ id, run, dependsOn[] }]`.
- Add `handleWorkflow` dispatcher (sibling of `handleSubtask`) in the v1 loop: topological sort → run independent steps concurrently (Effect fibers) → per-step retry → failure marks dependents skipped → resume from first incomplete step.
- Trigger sources: (a) a `workflow` tool the agent calls (emits a `WorkflowPart`), (b) a declarative config/plugin that loads a canned pipeline.
- Execution: steps run via the task tool (subagent) for heavy work, or raw effects for light declarative steps. Background jobs provide async execution.

**Verified caveat (corrected):** the UI does NOT have a dedicated subtask renderer today (grep of app/ui/session-ui found only a bootstrap reference). So "workflow steps visible in timeline" is NOT free — it needs a small UI addition to render `WorkflowPart`/step progress. Budget for it.

**Acceptance:** a 3-step pipeline with a dependency runs in DAG order; independent steps run concurrently; a failed step marks dependents skipped without killing the workflow; resume restarts from the first incomplete step; steps are visible in the session timeline.

**v2 carry-forward:** the workflow concept (DAG semantics) is abstracted so it can be re-homed onto the V2 Session Core when that lands; the v1 build is immediately usable on the live path.

## Guiding principles

- Reuse the existing harness seams (Runner, Truncate, permission, background) — no parallel systems.
- Each phase lands independently and is configurable; no phase blocks the next.
- Keep everything Effect-based and testable with the existing test harness.
