# Sidebar busy dot read the dead child-store map

- **Date**: 2026-09-30T13:30:38+0800
- **Type**: lesson

## What happened

The dot stayed dark through THREE successive fixes that all read the per-directory child store. That store's session_status map (child-store.ts:233) is never written by production, so any aggregation over it is permanently empty. Each fix passed typecheck and unit tests because the tests hand-constructed the child-store shape, so no test could observe the dead write.

## Root cause / fix

Read sync().session.data (info + session_status) from server-session.ts:213-214; sync().child(dir) is the raw child store (server-sync.tsx:707). Acceptance gate: a running subagent lights the dot, verified via GET /session/status.
