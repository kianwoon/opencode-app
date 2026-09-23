# Task-tool re-fire adopts the newest same-agent child — looks like a stale agent

GOTCHA: Re-firing `task` (same agent type) within HAND_REUSE_TTL_MS adopts the NEWEST child session of that agent under the parent (packages/opencode/src/tool/task.ts:314-354, `reused` generator, logs "Reusing subagent session") instead of spawning fresh; create is only the fallback (`session ?? reused ?? create`, :365-378). A resumed long-context session re-runs SLOWLY — the UI keeps showing the OLD transcript while the model warms up, so the re-fire reads as a stale/frozen agent and gets aborted by the user (2026-09-23: a live latch test was aborted exactly this way).

LATCH INTERACTION: the identical-completed-task latch (task.ts:265-281) matches BYTE-EXACT (subagent_type + description + prompt) over parent-history parts. Any prompt drift = latch MISS → falls through to the reuse path above. The refusal is recorded as an ERROR part ("Terminal: this exact task ... already completed") and a user abort can race/mask its delivery — verify in the DB, not the UI: `sqlite3 -readonly ~/.local/share/opencode/opencode.db "select datetime(time_created/1000,'unixepoch','localtime'), substr(data,1,200) from part where data like '%<description>%' order by time_created desc limit 5"`.

CORRECT PATTERNS: unique description per firing → guaranteed fresh spawn; `task_id` → deliberate resume; `force:true` → override the latch; a re-fire inside the TTL will REUSE, not spawn — do not read reuse as a hang.

ACCEPTANCE GATE: for a re-fire, the children query shows NO new session row (reuse) OR an ERROR part carrying the Terminal text (latch); the adopted session's new parts prove re-execution; UI staleness during a big-context resume is expected, not a bug.
