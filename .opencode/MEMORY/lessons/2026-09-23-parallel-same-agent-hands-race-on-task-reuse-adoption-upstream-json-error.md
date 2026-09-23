---
# Parallel same-agent hands race on task-reuse adoption → upstream "response was not valid JSON"

**Symptom**: two hands of the SAME agent type fired in parallel die with `Upstream request failed: [server_error] Upstream response was not valid JSON`; the adopted session's messages end with zeroed token counts (usage never recorded).

**Root cause**: `packages/opencode/src/tool/task.ts` reuse adoption picked ONLY the newest same-agent child and the `background.get(...).status === "running"` guard does not see FOREGROUND runs — two parallel tasks both adopted the same session and ran two concurrent prompts inside it, corrupting the upstream request. Each failed run refreshed `time_updated`, keeping the poisoned session inside the 20-min `HAND_REUSE_TTL_MS` window forever (adoption retry loop).

**Fix (2026-09-23)**: per-agent adoption POOL — iterate same-agent children newest-first with per-candidate guards, adopt first idle; module-level `adoptedInFlight` Set claimed inside the generator, released via `Effect.ensuring` on the `background.start` `run:` effect (a registration-site release unclaims mid-run because the background path returns early while `run:` still executes); adopted sessions re-titled to the new task's description. Agent-generic — applies to every agent type.

**Operational rules while the RUNNING app still has the old task.ts**: (1) never fire two same-agent hands in parallel — sequential or different agent types only; (2) a session that died mid-run with upstream JSON errors is POISONED — do not re-fire into it; wait >20 min without touching it so it goes TTL-stale, then the next same-agent hand creates a fresh session. Adoption happens at FIRE time, not first-command time — sleep-gate the fire itself.

**Acceptance gate**: `bun test test/tool/task-reuse-title.test.ts` from packages/opencode — 2/2 pass (adoption retitle; concurrent same-agent tasks → distinct session ids).
---
