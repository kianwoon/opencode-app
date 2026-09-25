# Parallel task calls collide on one subagent session; second hand's result lost

- 2026-09-26, opencode repo (orchestrator harness behavior, project-agnostic)
- GOTCHA: two `task` calls issued in ONE parallel block both mapped to the SAME
  subagent session (both returned id `ses_f2605fee6ffeyaVI7UR1r31OUm`). The first
  hand returned its result; the second was delivered into that same session as
  "additional context" and its result NEVER arrived (no completion notification
  across 5+ turns). Cost: one lost verification hand plus a re-fire.
- FIX: treat a hand with no result after the turn ends as LOST - do not keep
  waiting. Re-fire ONCE with a reworded prompt (byte-identical re-fires are
  refused by the reuse guard; rewording also forces a fresh spawn). Two-strike
  budget still applies.
- ACCEPTANCE GATE: parallel task calls return DISTINCT task ids; every delegated
  hand's result is either received or re-fired exactly once - never silently
  awaited across multiple user turns.
