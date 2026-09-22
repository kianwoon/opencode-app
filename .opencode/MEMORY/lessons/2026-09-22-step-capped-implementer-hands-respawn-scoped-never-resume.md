# 2026-09-22 — step-capped implementer hands: do NOT resume with the same scope; re-spawn ≤7-call scoped hands

Pattern: an implementer hand with a multi-deliverable spec (create file + 2 wirings + tests + verify) hit the 100-step cap mid-exploration; resuming it with "final attempt, no exploration" directives capped out 3 times (2 soft caps + 1 hard stop), each burning the full budget while delivering partial code — including 9 duplicate import statements pasted mid-file (caught by `bun typecheck`, not by the hand).

Fix: after a step-cap failure, spawn a FRESH hand per remaining deliverable: no exploration (name exact files/offset-ranges to read, max 1 bounded read), style rules inline, verify commands inline, ≤7 tool-call expectation. Fresh budgets + minimal scope completed in one pass what 3 resumes could not.

Acceptance gate: a re-delegation after a step-cap must narrow the hand's scope by ≥50% and name exact read ranges; if the same task id caps twice, never resume it again — fresh spawn only.
