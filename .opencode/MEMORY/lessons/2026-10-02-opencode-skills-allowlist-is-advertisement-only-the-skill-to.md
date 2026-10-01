# opencode skills allowlist is advertisement-only - the skill tool never re-checks agent.skills

- **Date**: 2026-10-02T04:01:21+0800
- **Type**: lesson

## What happened

packages/opencode/src/session/system.ts:142-145 filters the ADVERTISED skill list by agent.skills === undefined || agent.skills.includes(s.name), but packages/opencode/src/tool/skill.ts:9 declares only name: Schema.String with no agent/skills reference - the allowlist is enforced solely by not advertising off-list skills; a model invoking an off-list skill name from memory is not permission-blocked.

## Root cause / fix

treat agent.skills as prompt-side scoping, not a security boundary. If hard enforcement is wanted, check the invoking agent's skills inside the skill tool's execute. Acceptance gate: a unit test where an agent with skills=[a] invokes skill b and is denied.
