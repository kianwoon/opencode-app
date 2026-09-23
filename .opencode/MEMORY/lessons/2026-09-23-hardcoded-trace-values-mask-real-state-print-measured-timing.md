# hardcoded trace values mask real state print measured timings

- **Date**: 2026-09-23T14:39:14+0800
- **Type**: lesson

## What happened

jev-run's ESCALATE trace line printed a hardcoded (0ms, delta=n) literal. The literal read as a SYNCHRONOUS failure and sent diagnosis down the empty-controls and transport paths for two iterations, while the real failure was a 401 from a missing Bearer key taking normal network time. A string constant in a trace line manufactured a false symptom class.

## Root cause / fix

Trace lines must print MEASURED values: wrap the awaited call in const t0 = Date.now() and emit Date.now()-t0 per step. Acceptance gate: re-run shows varying real per-step timings, and grep for the literal '(0ms' in the script returns 0.
