# Plugin test files can terminate the desktop server

Symptom: renderer `TypeError: Failed to fetch` immediately after boot; utility log reports sidecar exited with code 0. Server stdout prints guard-suite PASS lines.

Cause: plugin auto-discovery imports every `plugin/*.{ts,js}` and `plugins/*.{ts,js}`, including `*.test.ts`. The global `plugins/ocu-guards.test.ts` executes tests at module scope and calls `process.exit()`, terminating the real server after it becomes ready.

Fix applied: move the test to `~/.config/opencode/plugin-tests/ocu-guards.test.ts`, outside discovery, preserving the actual `plugins/ocu-guards.ts`. Its import is absolute, so the move preserves execution. Do not put executable tests in auto-loaded plugin folders.

Command: `bun ~/.config/opencode/plugin-tests/ocu-guards.test.ts`.

Acceptance gate: suite prints ALL PASS; relaunch desktop; authenticated renderer fetches to `/global/health` and `/session` both return 200; fresh boot logs contain no test-suite output, sidecar exit, or Failed to fetch. No desktop rebuild is needed for this source-loaded plugin layout fix.

Recurrence at 16:39 Singapore time: the test was recreated in `plugins/` at 16:27 after the first move. The previous healthy process then imported it at 16:37 during config reload and exited; restart imported it again. Preserve updated tests only under `plugin-tests/`, including when regenerating the guard suite. Updated suite moved there and old version backed up beside it.

Root cause of the recurrences (fixed 16:46): the `com.kianwoon.opencode.guard-integrity` launchd watchdog was itself re-arming the bomb — its `target_for()` mapped `ocu-guards.test.ts` to the `plugins/` path, so every 900s tick (and each kickstart) "healed" the process.exit() suite back into auto-discovery. Watchdog restored it at 08:24, 08:27, and 08:42 UTC per watchdog.log; the 16:42 restore is the repeat crash. Fix: repoint `target_for()` (and header comment) to `plugin-tests/`, rm the file from `plugins/`, then `--update` to re-baseline the canonical copy from the updated suite. LESSON: when a "missing file" keeps coming back, find what resurrects it before re-fixing the file — a self-heal watchdog guarding the wrong path converts every cleanup back into the original fault.

Third recurrence: recreated test (mtime 16:49) killed the sidecar at 16:59. Moving files is not durable if another workflow recreates them. Source fixes were already pending in V1/V2 plugin discovery and V1 loader/init exit guard; the production app still had the 15:06 bundle. Rebuilt production desktop from the existing source fixes. Runtime acceptance must leave the problematic test present in `plugins/` and prove it is skipped. `bun test test/plugin/exit-guard.test.ts test/plugin/loader-shared.test.ts` from packages/opencode: 35 pass; core config/plugin suite: 8 pass; core/opencode/desktop typechecks pass. Node strip-types probe confirms exit guard contains process.exit and restores host exit.

Production acceptance verified at 17:16 Singapore time: distribution-signed OpenCode.app passes codesign --verify --deep; all four helper bundles are sealed; verify-prod confirms prod/opencode.db. Fresh boot 20261011T091638 with original plugins/ocu-guards.test.ts STILL PRESENT: renderer health/session/messages requests all HTTP 200 (10 messages returned), no sidecar exit, test PASS output, or Failed to fetch in fresh utility/server/renderer logs. Built existing uncommitted source fixes; no commit was created by this repair.
