# verify-state-predicates-selector-nesting-stale-toolmap

- **Date**: 2026-10-03T04:24:52+0800
- **Type**: lesson

## What happened

computer-aid.md's tool map documented verify_state element predicates as element.{role,label_contains,value_equals,exists,enabled,selected}; the driver's own validation error proved the real schema is element.{selector, exists, value_equals, enabled, selected} — matchers like label_contains nest INSIDE selector. The stale doc taught two consecutive flight handoffs the wrong payload shape, so ui_run's verify leg reported 'could not verify' while the runs themselves succeeded and were independently confirmed.

## Root cause / fix

When a tool rejects a payload with 'unknown field, expected one of ...', treat that error's field list as the authoritative schema: correct the CALLER's payload first, then fix the doc that taught the shape (doc-only edits reach fresh subagent sessions without an app restart). Acceptance gate: the corrected payload yields a real verdict (satisfied/unsatisfied) instead of 'could not verify', and the doc line names the selector nesting.
