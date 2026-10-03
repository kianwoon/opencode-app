# permissive-schemas-need-read-site-coercion-stringly-boolean-instance-2

- **Date**: 2026-10-03T04:13:41+0800
- **Type**: lesson

## What happened

Instance #2 of the stringly-boolean class (task.ts reuse was #1, documented in root AGENTS.md). ui_run's expect param is a deliberately permissive pass-through (Schema.Array of Record(String, Unknown)); the calling model emitted exists as the STRING "true" — the prose-teaches-tokens trigger fired from the CALLING agent's handoff, not the tool's own prose — the decode waved it through, and cua-driver_verify_state's strict Schema.Boolean rejected it, so every ui_run verify reported 'could not verify' while the run itself succeeded.

## Root cause / fix

A permissive pass-through schema cannot prevent string tokens, so coerce at the SINGLE read site: normalizeExpect walks predicates and coerces exact lowercase 'true'/'false' under boolean-typed keys (exists/enabled/selected), recursively over plain-object values; everything else passes verbatim (fail-open). Root-cause proof method: sqlite json_type on the stored part input distinguishes model-emitted text (json_type text) from downstream stringification (json_type boolean). Acceptance gate: pure-helper tests prove coercion AND pass-through of strings/reals; the end-to-end proof is a live run whose trace shows the verify verdict instead of 'could not verify'.
