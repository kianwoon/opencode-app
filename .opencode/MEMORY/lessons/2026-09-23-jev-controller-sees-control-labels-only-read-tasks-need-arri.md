# jev controller sees control labels only read tasks need arrival terminals decided driver side

- **Date**: 2026-09-23T14:54:56+0800
- **Type**: lesson

## What happened

jev-run's read task (Read the top notifications) reached the target page — the click landed with delta=y — but the next jevControl call returned an honest fold-null: action wait 0.37 / done 0.28 against threshold 0.7, http 200. Root cause: buildState passes goal, lastAction and control labels only; page CONTENT is invisible to the controller, so it can never confidently judge done for a read task and kept suggesting wait. The loop escalated after it had already arrived.

## Root cause / fix

Put read-task terminal semantics in the driver script, not the model: after an act with delta=y, if the fingerprint URL contains the target host+path, finish DONE and dump whitespace-collapsed main.innerText (1500 chars). Acceptance gate: the same run that previously ESCALATEd after arriving now returns DONE in 1 step (857ms observed) with the content block printed.
