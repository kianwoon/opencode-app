# resumed hand context poisons behavioral lessons latch onto them and refuse delegations

- **Date**: 2026-09-23T16:58:16+0800
- **Type**: lesson

## What happened

A subagent session that lived through a loop-diagnosis kept applying the behavioral rule it had absorbed (terminate on re-injected instruction blocks) to EXPLICIT task delegations: two consecutive handoffs with full 6-step implementation specs were refused with no work done, while the hand itself acknowledged the delegation was pending. The rule had no scope clause, and the resumed context outweighed the fresh instruction.

## Root cause / fix

Scope every behavioral lesson with an explicit SCOPE line naming whom it binds and what it never covers; when a resumed executor misapplies it twice, abandon the resumed session (2-iteration rule) and spawn FRESH — a clean context executed the identical spec first try (5/0 + 6/0 tests, typecheck 0). Acceptance gate: delegation refusals citing a behavioral lesson are treated as executor failure and escalated by executor switch, not by rewording the same prompt.
