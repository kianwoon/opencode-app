# Resumed step-exhausted hand returns byte-identical stale report (2026-09-22)

- **Symptom**: resuming a hand session (`task_id`) after it hit "maximum steps"
  returned a final report BYTE-IDENTICAL to the previous one
  ("Accomplished / Not completed / Next" — same text, same gaps: gates still
  unrun). It reads like a fresh completion but NO new work happened.
- **Cause**: the session's step budget was already spent; the resume produced
  zero tool activity and re-emitted the stored final report. Report text is not
  evidence of work.
- **Fix**:
  1. Never validate work by report prose — demand per-gate commands + exit
     codes, and diff against the prior report: byte-identical ⇒ treat as
     "no work done".
  2. When a hand returns "maximum steps reached", spend the next handoff on a
     FRESH spawn with fixed sequential steps (gates only), not a resume of the
     exhausted session.
  3. Before the fresh handoff, resolve the hand's leftover conditionals yourself
     with cheap reads so the gate handoff contains zero conditionals.
- **Acceptance gate**: a gate report lists each gate command with its exit code
  and pass/fail counts; any report identical to its predecessor is rejected as
  stale, not accepted as progress.