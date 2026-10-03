# verify-state-matcher-domain-labels-not-values

- **Date**: 2026-10-03T04:27:31+0800
- **Type**: lesson

## What happened

Second occurrence of the verify_state static-text matching gap (instance 1: Calculator display, value_equals unknown after 23 samples; instance 2: web form banner, selector.label_contains unknown after 16 samples while the element was provably present in the AX tree with its text in value and an empty accessible name). verify_state's matchers operate on the accessible-NAME (label) domain; web content and calculator displays expose their text as value with empty labels, so label-domain predicates poll until timeout and return unknown.

## Root cause / fix

For web/GUI verification prefer elements with real accessible names, or verify via AX read-back re-observation (query role and text directly from a fresh snapshot) instead of verify_state predicates on static texts. Treat unknown as a predicate-domain miss, never success. Value-domain matching would be a driver-side feature (matcher fallback to value), not a caller-side fix. Acceptance gate: any resolving predicate must be shown to target the label domain, and unknown is always reported honestly rather than folded into success.
