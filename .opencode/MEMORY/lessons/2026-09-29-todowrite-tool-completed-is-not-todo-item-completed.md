# Transport success is not domain completion

- **Date**: 2026-09-29T23:58:37+0800
- **Type**: lesson

## What happened

A tool call reported 100% "completed" (1507/1507) while the domain entity it was
supposed to track showed 462/553 (84%) completed. No data was corrupt.

## Principle

A tool-call / transport lifecycle status is NOT the status of the domain entity
the call manipulates. Transport says "the request succeeded"; domain says "the
work finished". These are different stores, different writers, different clocks.

This applies to any task queue, background job, batch run, or agent handoff.
Never infer domain completion from transport success. A queue whose transport
log is 100% green tells you only that every request was accepted.

## Future rule

1. Keep domain status in its OWN store, not as an inference over transport records.
2. A store overwritten wholesale on every update is risky: only the last write
   survives, so any snapshot reflects the last writer's view, not accumulated history.
   If you need history, version or append.
3. UI must render the domain store, not the part/transport status. Rendering the
   transport flag makes the UI look complete while the domain is not.
4. Diagnostics must query BOTH counts separately and report them side by side
   before drawing any conclusion about corruption or bug.
