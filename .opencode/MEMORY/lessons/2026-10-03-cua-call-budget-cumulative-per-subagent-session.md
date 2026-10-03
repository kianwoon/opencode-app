# cua-call-budget-cumulative-per-subagent-session

- **Date**: 2026-10-03T14:50:44+0800
- **Type**: lesson

## What happened

The cua-driver call budget counter is cumulative per SUBAGENT SESSION across handoffs and never resets on re-fire: a resumed session opened its re-fire already at 32/30 (prior flights totals), so every resumed re-fire started over cap and was mechanically doomed — one blocked flight was spent discovering this instead of doing the work.

## Root cause / fix

When re-firing per the two-strike rule, spawn a FRESH session — in the task tool pass reuse:false, because the default reuses the most recent session with its cumulative counter. Budgets are per-session lifetime, not per-handoff. Acceptance gate: the fresh hand's first budget read starts near 0/N, never above N.
