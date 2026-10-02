# jev-decide-cua-loop-contract

- **Date**: 2026-10-03T01:57:04+0800
- **Type**: lesson

## What happened

jev_decide returned target:null at 0.98 when the goal was ambiguous (select 'a digit' among 4 candidates) and the state string was handed down instead of observed; the envelope's success field is unreliable (success:true on a null target, success:false on a correct confident verdict), and verify_state value_equals never resolves on unlabeled AXStaticText (unknown after 23 samples).

## Root cause / fix

Goals must be determinate (name the target property, not a category); the state string must be derived from the fresh snapshot, never dictated by the handoff; consumers key on target validity + rule-1 token match against the same snapshot, never on the success field; null/unavailable means the operator self-decides (fail-open); for display-style verification prefer AX read-back re-observation over verify_state value predicates on unlabeled static texts.
