# A LIMIT clause on a count-feeding query changes the metric, not just the memory profile

- **Date**: 2026-09-28
- **Type**: lesson

## Gotcha

A `LIMIT` added to a query that feeds a COUNT or a RATIO changes the metric, not just the memory profile.

## Pattern

A query is bounded to stop unbounded memory growth (here: a `GROUP_CONCAT` over every user message in a 600k-token session). Three consumers of the result array then silently inherit the cap — the raw `array.length` used as a session-wide count, the same length used as a ratio denominator, and any whole-session aggregate folded over the array. The bound looks correct in review because the memory problem it solves is real, and the derived numbers are not obviously wrong at the cap (200 vs 201 is invisible).

## Fix

Split the concerns at the query, not at the consumer. Keep the bounded array for windowed features (trailing-idle, recent counts, recent similarity) and add ONE exact `count(*)` query using the identical `WHERE` clause for session-wide facts. A count is cheap and bounded regardless of table size. When adding any `LIMIT`, enumerate every consumer of the result and classify each as windowed or whole-session BEFORE accepting the bound.

## Concrete instance

`packages/opencode/src/jev/snapshot.ts` capped the prompts query at `SNAPSHOT_PROMPTS_MAX = 200` and then used `prompts.length` for BOTH `prompt_count` and the `todo_churn` denominator. A 201-message session reported 200 prompts, and its churn read `2/200` instead of `2/201` — a denominator error that changes the ratio, not just a display value. The fix keeps the window for the time-series features and adds a separate `SELECT count(*)` with the same `WHERE session_id = ? AND json_extract(data, '$.role') = 'user'`.

## Acceptance gate

A future reader can tell, from the code alone, which numbers are window-scoped and which are session-wide — the two must never share one source.
