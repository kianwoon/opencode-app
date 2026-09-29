# 2026-09-29: identical response loop — byte-identical tool-call block re-fired

**Gotcha**: the brain emitted 3+ byte-identical responses in a row twice in one session — same tool-call block, same first line — once via `todowrite`, once via parallel reads — AFTER the hands had already returned their final reports. That violates the two-strike rule, and each identical block burned a full turn for nothing.
**Tell**: the previous assistant turn's tool-call block is byte-identical to the one about to be sent.
**Fix**: on sending a block identical to the previous turn, STOP — either run the cheapest distinct diagnostic or produce the final answer. A hand that refuses under two-strike is FINAL: its refusal text is the deliverable, so integrate it, never re-fire it.
**Acceptance gate**: no more than 2 consecutive identical tool-call blocks per session; a refusal return triggers integration, not re-fire.
