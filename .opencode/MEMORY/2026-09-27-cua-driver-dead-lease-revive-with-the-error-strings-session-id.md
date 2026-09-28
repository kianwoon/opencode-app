---
# cua-driver dead lease: revive with the EXACT session id from the error string, never a new label

**Symptom (2026-09-27, Shopee cart flight):** a fresh GUI flight opened with 4-5 consecutive failures of the form `session 'mcp-48941-...' has ended; tool call '...' was rejected. Call start_session with this id to revive it`. The hand burned calls on wrong recoveries: `start_session` with a NEW label (`session=shopee-rerun`), param retries on `get_accessibility_tree` (takes no session param, so retrying it with labels is a no-op), and a switch to `list_windows` (same rejection).

**Root cause:** cua-driver leases are per-session-id. A lease that ended (aborted prior flight + idle time) rejects EVERY tool call until `start_session` revives THAT id. `start_session` with a new label creates a parallel lease; the dead one keeps rejecting. This is the documented failure mode behind `JEV_EXEMPT_TOOLS` keeping `cua-driver_start_session` routing-exempt ("start_session is the ONLY revive path", packages/opencode/src/jev/client.ts).

**Fix:** on the FIRST `session has ended` error, immediately call `cua-driver_start_session` with the EXACT session id copied from the error string, then continue the flight. GUI handoff specs carry this as a standing line so hands do not improvise recovery.

**Acceptance gate:** the next flight that hits a dead lease shows exactly ONE failed call before the successful revive (not 4-5), and the flight completes without switching observer tools.
---
