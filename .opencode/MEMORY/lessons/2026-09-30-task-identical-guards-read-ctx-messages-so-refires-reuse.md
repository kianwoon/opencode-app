# Task identical-task guards read ctx.messages, so a completed re-fire reuses instead of refusing

DATE: 2026-09-30 — repo /Users/kianwoonwong/Downloads/opencode (packages/opencode)

GOTCHA: the task tool's identical-task guards — the orphan check, the retry-storm bound, and the completed latch — all matched over `ctx.messages`, the PER-STEP view snapshotted before the current assistant message exists (and the same array plugins mutate via `experimental.chat.messages.transform`). The in-flight task part is therefore not in the view the guards scan, so a byte-identical re-fire of an ALREADY-COMPLETED task was invisible to the latch and fell through to the newest-same-agent-child reuse path instead of being refused. Evidence from the live DB: 4 byte-identical implementer task parts in one session, 2 of them completed via "Reusing subagent session"; zero parts anywhere in the DB match `state.error like 'Terminal:%'`, i.e. no guard of that family had ever fired.

FIX: the guards read the DURABLE part rows for `ctx.sessionID` from the `PartTable` (select filtered with `json_extract` on `session_id` and the `json` tool field) using the same identity predicate as before; `force:true` and the `task_id` escape hatches are unchanged. The per-turn parallel cap still reads the live parts of the current message, since that one is genuinely about in-flight concurrency.

RESIDUAL RISK: the `json_extract` predicate assumes the `$.state.input.*` payload shape. A change to that shape silently blinds every guard again — there is no type error, only a missing refusal. Re-verify the predicate whenever the task part's state/input serialization changes.

ACCEPTANCE GATE: a regression (`packages/opencode/test/tool/task-latch-persisted.test.ts`) asserting refusal while the completed part exists ONLY in the DB and is absent from `ctx.messages` — fails pre-fix, passes post-fix; the full task test set is green (56/56) and `bun typecheck` from `packages/opencode` exits 0.
