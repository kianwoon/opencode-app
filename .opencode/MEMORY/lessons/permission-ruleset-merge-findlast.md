# Permission allow in agent block is overridden by session-level rules (findLast)

**Slug:** permission-ruleset-merge-findlast
**Date:** 2026-09-22
**Area:** packages/opencode permission + agent config

## Symptom

A tool (`session_rename`) was registered and explicitly allowed in the agent's
permission block, yet never appeared in the model's tool list. Tool count in
`~/.local/share/opencode/head-hash.log` stayed `tools=10` across every step, and
`head=` never changed. No error surfaced — the tool was silently filtered.

## Root cause

`Permission.disabled` (`packages/opencode/src/permission/index.ts:219-229`) picks
the **last** matching rule:

```ts
const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
return rule?.pattern === "*" && rule.action === "deny"
```

A tool is hidden only when the TERMINAL match is `pattern:"*", action:"deny"`.

`Permission.merge` is a bare `flat()` (`permission/index.ts:215-217`) and callers
merge **agent rules first, then session rules**:

```ts
Permission.merge(input.agent.permission, input.permission ?? [])   // session/llm/request.ts:208-214
```

So a session-level (top-level `permission` in opencode.json) blanket deny lands
AFTER the agent block's explicit allow and wins `findLast`. The agent-block allow
is dead.

`config/brain.ts:11` already documents the ordering constraint ("`"*": "deny"`
must remain the FIRST key") — but that only protects ordering WITHIN the agent
block; it does nothing about session rules appended after it.

## Fix

Put the allow in the **top-level** `permission` block of
`~/.config/opencode/opencode.json` so it is the last key emitted:

```json
"permission": { ..., "session_rename": "allow" }
```

Key order matters: it must come AFTER any broader deny.

## Verification

- `~/.local/share/opencode/head-hash.log` `tools=` count increments (10 -> 11).
- Practical: the tool call succeeds.

## Gotchas found alongside

1. **Config is read at app startup.** Editing opencode.json while the app runs has
   NO effect until a full quit + relaunch. Symptom: config file correct, behavior
   unchanged, no error.
2. **`edit` tool can itself be blocked** by the pre-execution guardrail plugin
   (`.opencode/plugin-lib/task-effort-router.ts:822-837`), which classifies tool
   calls via a `noul` score and throws `guardrail denied: <tool> (noul X)`. The
   guardrail ALSO blocks bash commands that would disable it — it is
   self-protecting. Disable it manually from a terminal, never in-loop.
   Config: `~/.config/opencode/effort-router.json` -> `guardrail.enabled: false`.

## Anti-pattern to avoid

Do NOT port a missing tool into a second registry before checking whether it is
merely permission-filtered. Registering a Global-scoped node (`SessionV2.node`)
as a dep of a Location-scoped node (`packages/core/src/tool/builtins.ts`) pulled
an unbound layer node into the graph and crashed the server at startup with
`Unbound layer node: @opencode/v2/SessionExecution` at `compileNode`. The
typecheck errors (`'"Invalid tag dependencies"'`, `'"Missing dependencies"'`)
were the warning; committing past them broke the app.
