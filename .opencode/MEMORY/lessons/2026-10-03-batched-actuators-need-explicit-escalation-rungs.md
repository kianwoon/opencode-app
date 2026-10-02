# batched-actuators-need-explicit-escalation-rungs

- **Date**: 2026-10-03T03:51:05+0800
- **Type**: lesson

## What happened

ui_run (batched observe-decide-act loop) hard-failed its first real flight: type_text was issued without delivery_mode and the driver refused background key events on a multi-window pid (same_pid_keyboard_ambiguity, one pid owning 15 sibling windows) — 0 of 5 steps executed, while the naive see-act loop on the SAME task absorbed the identical refusal mid-flight by retrying with foreground delivery. The batching win (1 call vs 18, 10s vs 127s) came precisely from removing the implicit per-act recovery the naive loop provides.

## Root cause / fix

Every error class the naive loop could absorb needs an explicit SINGLE-rung escalation in a batched driver (here: retry once with delivery_mode foreground when the error text contains the refusal class; pointer actions never escalated — the refusal is keyboard-delivery-specific). Cover the escalation decision with a pure-helper test against the VERBATIM refusal text, and invalidate batch metrics when the batch produced no effect (observations '1 snapshot for 0 steps' means the time win is not a comparison).
