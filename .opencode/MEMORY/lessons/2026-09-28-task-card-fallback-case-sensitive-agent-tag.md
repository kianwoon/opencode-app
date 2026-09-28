# Task card fallback case sensitive agent tag

- **Date**: 2026-09-28T17:15:35+0800
- **Type**: lesson

## What happened

Gotcha: packages/session-ui resolveTaskSession fallback matched child-session titles with case-sensitive title.includes("@Implementer") while core writes titles lowercase as '<description> (@implementer subagent)' — fallback was dead, so task tool cards without state.metadata.sessionId (running window before the early ctx.metadata, error paths, legacy parts) resolved undefined and were not clickable.

## Root cause / fix

Fix: lowercase both sides (description, '@'+agent, title) in packages/session-ui/src/components/message-part-task.ts. Acceptance gate: bun test src/components/message-part-task.test.ts shows 4 pass / 0 fail and bun typecheck exits 0, both from packages/session-ui.
