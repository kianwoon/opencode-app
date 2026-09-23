# Resumed task sessions loop on aborted long commands — run-once-then-return + split long chains

**Gotcha**: Repeated `task` handoffs in one conversation can funnel into ONE persistent subagent session (every result returns the same task_id). Once that session accumulates many steps it hits "Maximum steps for this agent have been reached — tools disabled", and on subsequent long commands (`OPENCODE_CHANNEL=prod bun run build`, ~minutes) it can spin retrying the identical tool call — the harness loop-detector fires ("identical response 3 times in a row") while the brain side sees `Tool execution aborted`. Cost: a rebuild that produced nothing while burning retries.

**Fix**:
1. Diagnose before re-firing (all read-only, cheap): `ps -eo pid,lstart,etime,command | grep -E "bun run build|electron-builder"` (are processes even alive?), artifact mtime (did anything get produced?), `git log --oneline -2`, `git status --short`. Observed incident: zero build processes, asar mtime unchanged → safe to resume clean.
2. Resume the session with an explicit anti-loop preamble: "run each command EXACTLY ONCE; if a command fails, aborts, or errors, RETURN immediately with its raw output — NEVER repeat a failed or aborted command."
3. Split long chains (build / package / codesign / verify gates) into SEPARATE resumed handoffs so each hand is short; the 10-step single-hand version looped, the 1-command and 7-step versions completed green.

**Acceptance gate**: resumed hand returns per-step evidence with no repeated identical tool calls; the artifact mtime actually advances (observed: asar `17:25:41` → `21:11:25`) and `verify-prod.ts` prints prod + opencode.db.
