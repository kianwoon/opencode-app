# Permission knowledge: one generated source of truth, not prose

## Symptom
Agent prompts described their own grants in hand-written prose ("bash is echo-only") while the live config granted far more (git/ps/lsof/grep/sqlite3/graphify allows). Two sources of truth; the prose drifted silently, so agents guessed at their permissions and discovery happened through denial messages only.

## Root cause
Permission rules live in multiple config layers (top-level permission, agent-scoped blocks, session approvals) flattened into one ordered list resolved by findLast — but nothing surfaced the resolved result to the agent pre-flight, and the only agent-facing description was hand-written prose with no link to the evaluator.

## Fix
Generate the manifest from the same merged ruleset the evaluator consumes: `fmtPermissions(Permission.merge(agent.permission, session.permission))` (packages/opencode/src/session/system.ts), returned by the SystemPrompt service `permissions` method and injected into the frozen system head in prompt.ts between `gatedBlocks` and the ruleAnchor (never in `govBlocks` — binding context is not a governor drop-candidate). Config-derived only (session "always allow" approvals excluded) and deterministically ordered, so prompt-prefix caching stays intact: the frozen head changes only at a config epoch.

## Acceptance gate
- `bun test test/session/system-permissions.test.ts` green from packages/opencode.
- A fresh session's system prompt contains the "Effective tool permissions" block.
- Every DeniedError `matched` rule appears in the same session's manifest list.
