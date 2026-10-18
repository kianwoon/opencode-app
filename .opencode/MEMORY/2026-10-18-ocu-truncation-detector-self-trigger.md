# ocu-guards: advisory detectors must judge the driver body, never self-appended suffixes (2026-10-18)

## Gotcha
A regex detector that scans the tail of tool output will match advisory text the SAME
plugin appended to that output earlier in the hook — a self-trigger. In
`~/.config/opencode/plugins/ocu-guards.ts` the truncation advisory (lines 1237-1247)
scanned `output.output.slice(-2000)` for `/truncat|max_elements|max_depth/i`, but the
scroll branch (line 1206) had just appended `POST_SCROLL_OBSERVE_ADVISORY`, which
contains "max_elements 250+, max_depth 25+". Result: EVERY `cua-driver_scroll` output
falsely announced "[ocu] TRUNCATED AX TREE — this snapshot is a PARTIAL map" even though
no snapshot existed. The plugin violated its own invariant (lines 1254-1256: "a prior
plugin's advisory suffix is not part of the AX dump").

## Fix
`ocu-guards.ts:1239` — test `splitPriorAdvisories(output.output).body.slice(-2000)`
instead of the raw output. `splitPriorAdvisories` (module-level; splits at
`/\n\n(?=\[(?:jev|ocu)\])/`) strips [ocu]/[jev] suffixes, so only the driver's body is
evidence. Generalizes: a `[jev]` hint mentioning max_depth on a clean body no longer
fires either; a genuinely truncated body still fires.

## Acceptance gate
1. `bun ~/.config/opencode/plugin-tests/ocu-guards.test.ts` → ALL PASS (exit 0), now
   includes 3 trunc cases: scroll→NO advisory; body marker→advisory; clean body +
   [jev] max_depth suffix→NO advisory.
2. Probe (any fresh bun process importing the plugin): scroll false / clean false /
   real-truncated true.
3. Hard-block lines (the line-1148 throw, pointer/bash guards) byte-identical.

## Rule
Invariant: advisory/derivative detectors judge only the driver's body — run any
output-tail pattern test through `splitPriorAdvisories(...).body` first. Same class of
bug will recur anywhere a hook appends text before a later check reads it back.
