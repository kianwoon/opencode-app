# JEV head freeze hid session_rename

- **Date**: 2026-09-24T15:44:08+0800
- **Type**: lesson

## What happened

JEV first-turn routing omitted session_rename from the protected set, and the persisted session_stable_head then filtered it out for the rest of the session.

## Root cause / fix

Keep session_rename JEV-exempt and re-add current exempt tools when replaying a legacy frozen head; verify targeted tests, typecheck, and a live head containing session_rename after restart.
