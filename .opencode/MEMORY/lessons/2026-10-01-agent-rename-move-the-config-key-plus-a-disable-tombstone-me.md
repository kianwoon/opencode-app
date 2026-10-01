# Agent rename = move the config key plus a disable tombstone (merge cannot delete)

- **Date**: 2026-10-01T19:29:06+0800
- **Type**: lesson

## What happened

updateGlobal deep-merges (packages/opencode/src/config/config.ts:695) so an agent config key cannot be deleted. The in-block name field is NOT a rename: tool/task.ts:396 resolves subagent_type via agent.get(name), a KEY lookup, so a display-name override breaks task routing. The Subagent settings panel implements rename as: write the new agent key with the moved block, and set a disable tombstone on the old key (the runtime deletes disabled agents at agent.ts:273). Rename must be blocked for native agents and for the brain-wired set {brain, explorer, implementer, reviewer, guru, computer-aid}, whose names are hard-wired into brain.* model wiring and permission.task. Duplicate-name validation must check ALL agent names (runtime union config keys, tombstones excluded), not the selector list (which deliberately drops primaries).

## Root cause / fix

Acceptance gate: a rename writes both the new key and a disable tombstone on the old key; creating or renaming to an existing primary name is rejected; bun typecheck from packages/app exits 0.
