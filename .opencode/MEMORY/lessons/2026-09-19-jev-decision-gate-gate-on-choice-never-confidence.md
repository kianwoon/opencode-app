# Jev decision gate: gate on .choice, never .confidence

- **Date**: 2026-09-19T19:21:59+0800
- **Type**: lesson

## What happened

Jev tool-routing shipped and logged 'applied tools_before=22 tools_after=11' so it looked healthy, but Brains could no longer delegate: the subagent 'task' tool was being stripped. Root cause: the keep-loop read the answer's 'confidence' field and kept any tool with confidence >= 0.7, ignoring '.choice'. Jev's 'confidence' is confidence in the LABEL it chose, so a confident SKIP (edit 0.76, webfetch 0.97) cleared the gate and was KEPT, while a low-confidence USE (task 0.42) was DROPPED. The 'applied' log counted a random subset, which is why green logs proved nothing.

## Root cause / fix

Model a categorical decision answer as {use, strength}: keep iff choice === 'use' AND probabilities.use >= threshold; never compare 'confidence' to the threshold. Add an exempt set (task/StructuredOutput/invalid) so delegation and the json_schema finish path cannot be routed away. Acceptance gate: unit test asserting (a) confident skip with confidence 0.74 -> DROP, (b) weak use with confidence 0.11 -> KEEP/DROP by p_use, (c) exempt tools survive a unanimous skip. Red flag to remember: a 'tools_before/tools_after' log line only proves SHAPE CHANGED, never that the right subset was kept.
