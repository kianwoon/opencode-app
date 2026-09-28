# Task card fallback case sensitive agent tag

- **Date**: 2026-09-28T17:15:35+0800
- **Type**: lesson

## What happened

Gotcha: packages/session-ui resolveTaskSession fallback matched child-session titles with case-sensitive title.includes("@Implementer") while core writes titles lowercase as '<description> (@implementer subagent)' — fallback was dead, so task tool cards without state.metadata.sessionId (running window before the early ctx.metadata, error paths, legacy parts) resolved undefined and were not clickable.

## Root cause / fix

Fix: lowercase both sides (description, '@'+agent, title) in packages/session-ui/src/components/message-part-task.ts. Acceptance gate: bun test src/components/message-part-task.test.ts shows 4 pass / 0 fail and bun typecheck exits 0, both from packages/session-ui.

## Residual class (2026-09-28, later): task_id handoff cards are unresolvable until completion

Gotcha: a `task` call with `task_id` (handoff/resume of an existing subagent session) carries NO `state.metadata.sessionId` while running (live DB: empty mid-run, populated only at completion), and the title fallback can never match — the resumed session's title starts with the ORIGINAL task's description, not the new call's. Result: the running card was dead for the whole run. Fix: `clickable` memo in `packages/session-ui/src/components/message-part.tsx` now treats `running()` as resolvable — click queues navigation, the queued-nav effect fires when the link lands. Acceptance gate: `bun test src/components/message-part-task.test.ts` green + `bun typecheck` exit 0 from `packages/session-ui`.

## Third class (2026-09-28, later): a task_id handoff names its target in the INPUT

Gotcha: for a `task_id` handoff the tool part carries `state.input.task_id` = target session id from creation, while `state.metadata.sessionId` stays EMPTY for the entire run and lands only at completion (live DB: 3 consecutive handoffs, all empty mid-run, populated after). A resumed session's title also starts with the ORIGINAL task's description, so the title fallback can never match it. Result: the running card was clickable but a click had no target (queued navigation resolved at completion, minutes later). Fix: `resolveTaskSession` now reads `input.taskId` as an exact source, right after `metadata.sessionId` and before the title fallback; both call sites in `packages/session-ui/src/components/message-part.tsx` pass `task_id` from the tool input. Acceptance gate: `bun test src/components/message-part-task.test.ts` shows 6 pass / 0 fail and `bun typecheck` exits 0 from `packages/session-ui`.
