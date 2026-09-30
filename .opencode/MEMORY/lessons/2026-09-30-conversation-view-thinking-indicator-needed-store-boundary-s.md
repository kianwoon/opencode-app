# Conversation-view thinking indicator needed store-boundary status normalization + instance-scoped snapshot merge

- **Date**: 2026-09-30T17:19:59+0800
- **Type**: lesson

## What happened

Symptom: the desktop conversation view showed ZERO working feedback while the assistant worked (no Thinking shimmer, composer never flipped to stop), while the sidebar busy dot lit normally and masked the bug. Root cause (a): the v1 wire reports running sessions as type "running", absent from the generated SessionStatus union, so every UI gate (which compares "busy") missed it; only the 20s snapshot seed normalized it, the event path stored it raw. Root cause (b): GET /session/status through the server-wide client is INSTANCE-scoped server-side, so it missed sessions running in other directories' instances and the reconcile then cleared their live busy states every STATUS_VERIFY_MS. Diagnosis method that worked: a WINDOW-VALIDATED DOM probe -- the CDP probe must first prove it reads the REAL window by checking the brain session row's .animate-status-blink dot is lit in the SAME read, THEN count [data-slot=session-turn-thinking]; two earlier probe families died on (i) closure variables leaked into the Runtime.evaluate expression string (ReferenceError, NO_VALUE) and (ii) reading a wrong/stale target, both already recorded in the 2026-09-30 CDP-traps lesson.

## Root cause / fix

Fix: normalize status at the STORE BOUNDARY (event case maps running to busy, same as the seed) and merge per-directory status snapshots for locally-busy sessions' own directories before seeding (mergeDirectoryStatuses, v1 branch of the active fetch), commit 33400c4474. Acceptance gate: the Thinking indicator is visible during a live turn on the prod build (visually verified 2026-09-30 about 17:15, from the 17:01 build of 33400c4474); DOM probe shows [data-slot=session-turn-thinking] count greater than 0 during a busy turn; unit tests cover the merge helper and the running-to-busy event normalization.
