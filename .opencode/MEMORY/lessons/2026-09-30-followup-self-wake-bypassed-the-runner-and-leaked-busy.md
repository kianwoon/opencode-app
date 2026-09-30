# Followup self-wake bypassed the runner and leaked busy

- **Date**: 2026-09-30T18:54:16+0800
- **Type**: lesson

## What happened

Sidebar dots kept blinking on finished tasks; GET /session/status?directory=<dir> still returned {"type":"busy"} 13+ minutes after a clean step-finish reason "stop". The V1 loop's exit edge (packages/opencode/src/session/prompt.ts:2059) forked a raw runLoop(sessionID, "wake") instead of going through state.ensureRunning. A raw runLoop sets busy at the loop top (:1946) but finishRun - the only publisher of idle (packages/opencode/src/session/run-state.ts:64-67) - wraps ONLY fibers started via ensureRunning (packages/opencode/src/effect/runner.ts:83-91,131-135). Every turn finishing within FOLLOWUP_DELIVER_DELAY_MS (30s, prompt.ts:84) of its prompt took the fork branch and leaked busy until restart. Introduced with followup delivery (4020bd1c91).

## Root cause / fix

Fix 6ce5ed39b4: wrap the wake in state.ensureRunning(sessionID, findLastAssistant(sessionID), runLoop(sessionID, "wake")). findLastAssistant is the :1944 alias because lastAssistant is shadowed by the destructured message in that scope. Rule: any code path that starts or resumes a v1 turn must enter through state.ensureRunning - a raw runLoop can set busy but never clears it. Acceptance gate: test "v1 self-wake after a due followup returns the session to idle" in test/session/prompt.test.ts green (75 tests, 74 pass, 1 skip) plus bun typecheck exit 0; live, a completed session is absent from GET /session/status?directory=<dir> within ~30s of completion.
