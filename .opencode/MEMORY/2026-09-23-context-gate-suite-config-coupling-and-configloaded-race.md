# Context-gate plugin suite: real-config coupling + configLoaded async race (2026-09-23)

Gotcha: `bun test context-gate` (from packages/opencode) reads the REAL ~/.config/opencode/context-gate.json via CONFIG_PATHS() (context-gate.ts:90-95, lazy per-call env read). With the user's real config {"scopingEnabled":false,"summarizeEnabled":false}, gateSystem early-returns at :1017 and 5 withholding assertions fail (35/5). NOT fixable by env fixture alone: loadConfig() sets configCache={...DEFAULTS} synchronously but configLoaded=true only inside a fire-and-forget async read (:128/:135), so early transforms short-circuit on !configLoaded before the flags are ever consulted — identical 35/5 with and without OPENCODE_CONFIG_DIR isolation.

Ruling: the 5 failures are pre-existing environmental (isolated failing test touches none of the batch's rewritten sites; identical result with/without fixture). Release gates for the 2026-09-23 batch: typecheck 0, bun test jev 80/0, roundtrip 3/3, node probe 0.

Queued fix (needs source seam): export a test-only await (mirroring __resetFlightsForTest) that triggers loadConfig and resolves once configLoaded===true; hook suite awaits it before asserting; plus OPENCODE_CONFIG_DIR fixture with gate ON for hermetic runs.

Acceptance gate for the seam fix: OPENCODE_CONFIG_DIR=<fixture> bun test context-gate → 40/0 from packages/opencode, with roundtrip 3/3 and node probe 0 unchanged.
