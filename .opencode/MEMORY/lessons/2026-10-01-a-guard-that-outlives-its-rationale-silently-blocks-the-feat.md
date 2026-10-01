# A guard that outlives its rationale silently blocks the feature (subagent delete)

- **Date**: 2026-10-01T21:08:30+0800
- **Type**: lesson

## What happened

The Subagent settings panel deleted-guard blocked native agents AND any name where the brain model key resolved (brain plus the five legacy hands). That rationale died once brain dispatch became registry-driven (permission.task allow-all) and model wiring became capability-driven with a legacy fallback, but the guard stayed and blocked EVERY subagent the panel lists (the five hands plus native explore/general), so deletion was impossible. Deleting is safe: the runtime honours a disable:true tombstone (agent.ts deletes disabled agents) and the brain expander never re-materialises a name already present in the agent map; the panel already filters tombstones from its selector.

## Root cause / fix

When you remove or bypass the mechanism a guard protects, sweep the guards that referenced it. Acceptance gate: packages/app bun typecheck exits 0; the previously blocked action is available; and a regression test asserts a disable tombstone on a legacy-named agent survives brain.expand (not resurrected) - bun test test/config/brain.test.ts green from packages/opencode.
