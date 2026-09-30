# CDP sidebar probe: four traps, each a false zero-dots or false server-lies reading

- **Date**: 2026-09-30T16:01:06+0800
- **Type**: lesson

## What happened

Four verified traps when probing desktop sidebar state over CDP: (a) a Runtime.evaluate expression runs in the PAGE context and CANNOT see node script module-scope variables — a leaked closure throws ReferenceError and result.value is undefined on EVERY sample (uniform NO_VALUE x N with a healthy connection); inject values with ${JSON.stringify(x)}. (b) session-row titles are LLM-rephrased from the task description ("Dot acceptance probe final" became row title "Final dot acceptance probe ...") so a title-prefix match NEVER matches — resolve data-session-id from ~/.local/share/opencode/opencode.db (session table; newest parent_id IS NOT NULL row is the newest subagent, i.e. your own probe). (c) an app restart rotates the sidecar port (60051 -> 53872; find it via lsof -nP -iTCP -sTCP:LISTEN | grep -i electron | grep 127.0.0.1) AND invalidates the previous CDP ws target — re-list http://127.0.0.1:9222/json fresh at probe start; reusing recorded values yields silent empty readings ({} bodies, HTTP:000). (d) a bare curl /session/status with NO directory context is NOT evidence nothing is busy: the handler (packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:77-78) returns Object.fromEntries(statusSvc.list()) from per-instance InstanceState, so a directory-less request routes to a DIFFERENT instance registry and returns {} while sessions run elsewhere — the app's own client passes directory routing.

## Root cause / fix

Self-busy probe: run the sampling loop as ONE long tool call inside your OWN session (guaranteed mid-tool for the whole window, so no identity lookup can fail), then corroborate with a VISUAL screenshot check of the real focused window because a background window's DOM is not the user's view. Never conclude fix-not-holding from uniform NO_VALUE (environment), a zero row count (row not rendered), or an unscoped curl (wrong instance).
