# 2026-10-25 — Guard-stack rescue: substring grants, write-once state, blast radius

## Gotcha
Three systemic defects across `~/.config/opencode/plugins/*` guards, all found by audit (2026-10-25):
1. **Whole-command substring grants** — `command.includes("allow_pointer")` / `/graphify query/` let text in ANY segment disarm or grant. Fix: per-segment matching only, one canonical `segments()` in `plugin-lib/guard-core.ts`; ocu-guards + graphify-gate import it (no drift possible).
2. **Write-once-never-rearm persistence** — graphify USED_MARKER made the gate a permanent no-op; identity-gate MAX_BLOCKS=2 failed open forever. Fix: time-bounded leases (`writeLease`/`readLease`, expired = auto-delete = re-arm).
3. **Blast radius** — identity-gate scanned the WHOLE agent dir on any tool call and threw for unrelated files. Fix: scan only tool-targeted paths; unknown target → warn, never throw.

Plus: `catch { return true }` fail-open in graphify `rootUnlocked` — a lease-read filesystem error must fail CLOSED (reviewer-found).

## Commands / acceptance gate
- `bun test` from `~/.config/opencode/plugins/` (note: `ocu-guards.test.ts` is a process.exit script — bun's summary truncates; judge by per-line PASS + exit 0).
- `bun test` from `~/.config/opencode/plugin-lib/` — 405 tests incl. guard-core, baseline/hardcode cores.
- New guards must: per-segment matching for grant/deny tokens, time-bounded + re-armable state, scoped to what the tool touches, single-line `appendDecision` rows (schema:2, mandatory `kind`), default shadow mode (env > config > shadow, see claim-evidence-gate.ts).
- `GUARDS.md` in plugins/ is the per-guard contract table — update the row with every guard change.

## Process
- decisions.jsonl migrated to schema:2 (391→391 rows, 0 dropped; backup `.bak-schema2`; `checkLedger` = the validator). Prior repair had silently lost 12 rows — never drop: unrecoverable lines go to `<path>.rejected`.
- hardcode-guard FPs on remediation handoffs are expected (case-specific facts are the point); use its logged `hardcode-guard:allow <reason>` override, don't fight it.
- CEG (claim-evidence-gate.ts, shadow) logs `ceg_ungrounded_citation` / `ceg_unbacked_verified` / `ceg_simulated_measurement` — flip to enforce only after telemetry shows low FP rate. Plugin API has no assistant-text hook; CEG gates task handoffs + written content + tool outputs instead.
