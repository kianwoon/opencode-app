# Permission manifest order is preserved end-to-end; verify from session_stable_head, never recall

- **Date**: 2026-09-29T05:06:07+0800
- **Type**: lesson

## What happened

Reported that the manifest rendered the bash redirection-deny BEFORE the bash allows, i.e. out of order vs config and runtime, then hunted a nonexistent re-renderer. False: fromConfig(Object.entries), merge(flat), resolveEffective(filter) and fmtPermissions(map) are all order-preserving, and the DB frozen head shows config order.

## Root cause / fix

Before any manifest-order claim, read the frozen head: sqlite3 -readonly on ~/.local/share/opencode/opencode.db, select substr(system,1,600) from session_stable_head for the session. Confirm phrase presence with instr(system, phrase). Grep app.asar and packages/desktop/out before claiming a string exists.
