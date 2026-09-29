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

## Fourth class (2026-09-29): phantom "running" card — stale UI, not a resolver gap

Gotcha: user clicks a task card showing a spinner, nothing happens — but the DB part is already `completed` WITH `metadata.sessionId`, and the child session is healthy. The renderer missed the part-update (completion + metadata) events, so its snapshot has no resolvable target, and the click hits the silent-queue branch (`running()` plus no id sets queued and waits forever). Diagnose from the DB, not the screenshot: (1) select id, time_created, time_updated, session_id, status, sessionId for the call — completed plus populated plus updated minutes ago means stale UI; (2) whole-DB scan for status in (running, pending) — empty means no genuinely-running card exists; (3) child health: message and part counts, time_archived null, loop-exit line in opencode.log. Rule OUT before blaming the resolver: adapter onNavigateToSession in packages/app/src/pages/directory-layout.tsx line 67 is an unconditional navigate of href(id) (no store lookup, no silent drop); the only silent branches are queued-while-running-no-id and a missing navigateToSession. Acceptance gate: re-click with fresh state navigates; if it still fails, it is a deterministic nav or view bug, not resolution. Related: reuse adoption funnels several same-agent calls into ONE child (observed 3 explorer calls into ses_f145afa62, title equals last adopter description), so fewer subagent sessions than task cards is normal — count parts, not sessions.
