# Bounding subagent fan-out: depth guards don't cap breadth, and `ctx.messages` can't see same-turn siblings

Gotcha: `subagent_depth` bounds *nesting*, not *parallelism*. A model looping on a
single assistant turn emitted **9161 identical `task` tool parts ~4ms apart**
(child `ses_f4566db0fffearvS8fvOHl3916`) — every one passed the depth check
(`packages/opencode/src/tool/task.ts:174`, `depth >= (cfg.subagent_depth ?? 1)`,
default 1), because at depth 0 a *main-agent→child* call is always legal no matter
how many siblings are in flight. Depth cannot see breadth; a separate per-turn cap
is required.

Second gotcha, the one that makes the naive fix fail: **`ctx.messages` cannot
detect same-turn siblings.** In `packages/opencode/src/session/prompt.ts` the
message list is projected (`MessageV2.filterCompactedEffect`) BEFORE the current
assistant message is created, then passed once to `SessionTools.resolve` →
`context()` (`packages/opencode/src/session/tools.ts:87`, `messages: input.messages`).
So the assistant message executing the fan-out is simply absent from that snapshot,
and parallel siblings in the same turn are invisible to it. A cap counting
`ctx.messages` parts NEVER fires — a silent no-op that looks correct.

Fix: count the live projected parts of the *current* message —
`MessageV2.parts(ctx.messageID)` (`packages/opencode/src/session/message-v2.ts:512`) —
filtered by `part.tool === id`. Exclude self by `callID` and re-add `+1`: the
caller's own part is usually already persisted (processor `ensureToolCall` runs
before dispatch) but need not be for direct invocation, so `callID` filtering keeps
the count exact. Refuse with `Effect.fail` BEFORE `sessions.create` so no child
session row is minted (the row mint *is* the storm's cost).

Acceptance gate: (a) 5 siblings + caller passes, 6 fails with the cap message and
`children(chat.id)` is unchanged; (b) siblings must be seeded as real DB parts on
the SAME `messageID` — a test that stubs only `ctx.messages` passes vacuously;
(c) workflow concurrency is unaffected because each step mints its OWN
`assistantMessage` (`prompt.ts:376`), so the cap is per-step-message, not per-workflow.

Baseline trap: `test/tool/task.test.ts` has a flaky 5s-timeout failure
(`description sorts subagents by name`) that appears only under load; the stable
baseline is **2** fails (`hides denied subagents`, `shapes child permissions`).
Stash-compare before claiming a regression.
