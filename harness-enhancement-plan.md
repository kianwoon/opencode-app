# Opencode Harness Enhancement Plan

Date: 2026-08-28
Status: ✅ All phases implemented (0–3, commits a9575281fd → b6684a7646)
Goal: Personal daily-driver — fast, pragmatic, plugin/config-first shipping

## Implementation Status (updated 2026-08-29)

| Phase | Deliverable                        | Commit       | Notes                                                                                                                                                                 |
| ----- | ---------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan  | `harness-enhancement-plan.md`      | `a9575281fd` | Analysis + phased plan committed to main                                                                                                                              |
| 0     | Effort router activated            | `e43f7bc872` | Auto-discovery wrapper in `.opencode/plugins/`; context optimizer was already live globally (676k+ tokens saved)                                                      |
| 1     | TaskProfile assessor               | `437e03d653` | Heuristic assessment in effort router: `{complexity, risk}` → pre-escalated baseline + risk notice; 16 tests                                                          |
| 2     | Workflow DAG engine resurrected    | `d0e1460473` | Recovered from `ab647985c4` (removed by v1.18.24-25 merge); ported onto current tree; 89 tests green; `OPENCODE_EXPERIMENTAL_WORKFLOWS=false` to disable (default ON) |
| 3a    | Verification gate + reviewer pass  | `335996f69f` | Pure risk detector + one reviewer subagent pass at task tail; `OPENCODE_EXPERIMENTAL_VERIFICATION` (default OFF)                                                      |
| 3b    | Followup delivery mode             | `f78dc5ef1a` | `delivery: "followup"` + `deliverAt` through schema/event/projector/SQL/runner; `SessionExecution.schedule` wake-at-time                                              |
| 3c    | Durable BackgroundJob record slice | `b6684a7646` | `background_job` table, best-effort lifecycle recording, restart sweep, list/get merge                                                                                |

Binaries: CLI `0.0.0-main-202608281602` (Phases 0–2) installed to `~/.opencode/bin`;
desktop app rebuilt via the `OPENCODE_CHANNEL=prod` chain with `verify-prod.ts`
passing. Rebuild both again to pick up Phase 3 (post-`b6684a7646`).

## Architecture Decision

**Enhance opencode internally along six pillars; reject the external meta-harness.**

The design doc (AI Harness Design Summary) correctly identifies six capabilities a
modern harness needs, but its topology recommendation (an external meta-harness
above opencode) is wrong for this setup: opencode's plugin API + V2 seams are
already sufficient to build these pillars in-process. Two of the hardest pillars
already exist as dormant, tested plugin prototypes. A meta-harness would duplicate
session state, permissions, events, and tool plumbing — a second harness.

Revisit meta-harness only if non-opencode agents (Codex CLI etc.) must be driven
later; the ACP service (`packages/opencode/src/acp/service.ts`) is the natural
future seam for that, not a new outer harness.

## Verified Capability Map (2026-08-28, HEAD 012e557112)

| Pillar                    | State in opencode                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context engineering       | Strong base: System Context delta algebra (`packages/core/src/system-context/`), epoch persistence, compaction (V1 `packages/opencode/src/session/compaction.ts`, V2 `packages/core/src/session/compaction.ts`). No per-step budgets, no retrieval, no ranking. **Dormant plugin exists**: KV-cache-aware context pruner (`~/.config/opencode/plugin-lib/context-optimizer-{core,v2-core}.ts`, ~1,400 lines, tested) |
| Dynamic effort/routing    | Effort variants mechanically work per turn (variant merge in `packages/opencode/src/session/llm/request.ts`). No task-complexity assessment in core. **Dormant plugin exists**: self-adjusting effort governor (`.opencode/plugin-lib/task-effort-router.ts`, committed `69ba9b13a4`, tests at `packages/opencode/test/plugin/task-effort-router.test.ts`)                                                           |
| Persistent runtimes       | V2 durable prompt admission + steer/queue promotion are solid. BackgroundJob is process-local **by design** (`packages/core/src/background-job.ts`). No follow-up/scheduled delivery mode. Post-crash continuation intentionally deferred (`specs/v2/session.md`)                                                                                                                                                    |
| Multi-agent orchestration | A complete workflow DAG engine (admission, concurrency cap, deadlock detection, 50k-step tests) was **built then removed at HEAD** in the v1.18.24-25 merge. Fully recoverable from git `ab647985c4`                                                                                                                                                                                                                 |
| Model/harness decoupling  | `@opencode-ai/llm` is a clean 4-axis route architecture (Protocol/Endpoint/Auth/Framing/Transport) with native/AI-SDK runtime gating (`packages/opencode/src/session/llm.ts`). Only a non-LLM backend shape is missing                                                                                                                                                                                               |
| Meta-harness              | Unnecessary given plugin seams: `chat.params`, `chat.message`, `tool.execute.before/after`, `experimental.chat.messages.transform` proved sufficient with zero core changes                                                                                                                                                                                                                                          |

Key routing/policy seams for new logic:

1. `session/prompt.ts :: createUserMessage` — turn's model/variant frozen here
2. `session/llm/request.ts :: prepare` — per-turn option merge chain
3. `session/llm.ts` runtime seam — generalize to N-way backend registry
4. `core/src/tool/registry.ts :: materialize` — tool-definition filtering by policy
5. `session/processor.ts` usage accounting — exact cost numbers for enforcement
6. `session/compaction.ts :: select` — budgeted retention algorithm

## Phases

### Phase 0 — Activate dormant prototypes (zero core changes)

- Register `task-effort-router` and the context optimizer plugins in
  `.opencode/opencode.jsonc` (or local `plugin/` dir), keeping library code in
  `plugin-lib/`.
- Port the V2 optimizer's `context.messages.transform` hookup to the current
  runner seam if needed; run its existing test file.
- **Acceptance**: effort escalations visible; prune triggers only over budget;
  KV-cache prefix stability verified by optimizer tests; a week of real use.
- **Gate to Phase 1**: both behave well on real workloads.

### Phase 1 — TaskProfile assessor (the missing brain)

- New module `packages/opencode/src/session/profile/` (or plugin first): a
  lightweight pre-prompt LLM call or heuristic classifier (diff surface, file
  count, test presence) producing `{complexity, risk, effort, contextBudget,
verification}`.
- Wire as a policy producer: feeds effort-router baseline, optimizer cap
  (per-task), tool/subagent budgets.
- **Acceptance**: simple tasks never see above-minimal effort; risky tasks
  (migration/CI edits) get reviewer subagent suggested; assessment cached per
  user message; adds <1 cheap call per task boundary.

### Phase 2 — Resurrect + durable-ize workflow orchestration

- Restore from git history:
  `git checkout ab647985c4 -- packages/opencode/src/session/workflow packages/opencode/src/tool/workflow.ts`
- Fix config schema references (`workflow_concurrency` was removed from
  `experimental.ts` — re-add or hardcode default 4).
- Upgrade: persist `WorkflowPart` step state to the V2 event store so
  interrupted workflows resume instead of fail; per-step retry policy (failure
  = scheduling outcome); feature-flag initially.
- **Acceptance**: DAG tests from history pass; kill -9 mid-workflow → `wake`
  resumes remaining steps; concurrency cap honored.
- **Depends on**: Phase 1 — the assessor decides when a task warrants
  orchestration vs a single loop.

### Phase 3 — Persistent runtimes + verification gates

- **Durable BackgroundJob**: replace in-memory `SynchronizedRef<Map>` in
  `packages/core/src/background-job.ts` with a `session_input`-style durable
  table; the `start/wait/promote` interface already matches.
- **`followup` delivery mode**: extend `Delivery` union in
  `packages/schema/src/session-delivery.ts`; promotion machinery in
  `packages/core/src/session/input.ts` generalizes (wake-at-time).
- **Verification gate in TaskProfile**: `verification: "none" | "tests" |
"reviewer"` — harness programmatically spawns reviewer/test subagent via
  `runSubagentTask` (not model-invoked), settling results before idle.
- **Acceptance**: restart mid-background-task → job continuable; followup
  prompts fire on schedule; risky tasks always end with a reviewer pass.

## Strategic Notes

- **V2-runner-first** for all new work; avoid the V1/V2 duplication trap
  compaction fell into.
- **Plugin-first for every Phase 1/3 feature**, graduating to core only when
  interfaces stabilize — minimizes upstream-merge surface.
- **Unify token estimation** when Phase 1 lands: `chars/4`
  (`packages/core/src/util/token.ts`) vs optimizer's CJK-aware 3.6 factor.

## Risks

- Workflow resurrection will not cherry-pick cleanly (config/schema refactors
  in the removal merge); expect a half-day of porting.
- Plugin load order gotcha: `@opentui/solid/preload` can leak the real global
  config into tests; use `OPENCODE_CONFIG_DIR` isolation for provider tests.
- Context-optimizer lives outside the repo (`~/.config/opencode/plugin-lib/`);
  Phase 0 should bring a copy into the repo so it is versioned with main.
