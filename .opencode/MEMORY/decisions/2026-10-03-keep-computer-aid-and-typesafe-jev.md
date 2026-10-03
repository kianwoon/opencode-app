# keep-computer-aid-and-typesafe-jev

- **Date**: 2026-10-03T13:10:30+0800
- **Type**: decision

## Context

Keep the computer-aid LLM as planner and the typesafe jev endpoint as the categorical decider; ui_run and the GUI loop stay on jev. Bring-over from trycua/cua is limited to measurement (Cua Bench), upstream engagement, and driver hardening.

## Decision / rationale

Over adopting CUA-S1 checkpoints (nano, form-v0, 4b) as deciders or planners, and over any distillation path that would replace jev. User directive 2026-10-03 — also evidence-backed: jev already occupies the S1-nano architectural slot with measured numbers (batched 34-43s per 1 call vs naive 127s per 18 calls), and S1-form-v0's documented high-confidence out-of-vocabulary skip (29.3 percent held-out accuracy) is precisely the silent-no-op class this stack hunts.
