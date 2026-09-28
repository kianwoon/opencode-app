---
# Thin GUI handoffs: standing ops live in computer-aid's agent definition — hand off goal + boundaries only

**Symptom (2026-09-27):** every computer-aid handoff re-specified ~20 lines of standing boilerplate (money/credential boundaries, dead-lease revive, pacing budgets, report format) that the specialist's definition largely already carried (binding rules 0-5 + LOOP: observe-cheaply, targeting ladder, revive-once, fill hygiene, ≤30-word reasoning). Double planning: the brain front-loads a spec, then the specialist re-plans under it.

**Root cause:** computer-aid's definition (`~/.config/opencode/agent/computer-aid.md`) already owns targeting/observe/scroll/fill/loop discipline; only boundaries, batch amortization, flight budgets, and report format were missing — now patched in as "STANDING FLIGHT DEFAULTS" (backup: `computer-aid.md.bak-specialistops`).

**Fix:** GUI handoffs to computer-aid are THIN — (1) goal, (2) task-specific boundaries (e.g. "stop at order review"), (3) report emphasis only when it deviates from the standing format. Do NOT re-specify standing boilerplate; do NOT pre-resolve cua-driver surfaces — the specialist owns its driver.

**Acceptance gate:** the next GUI handoff fits in ≤10 lines and the flight still enforces boundaries/budgets (stop-before-payment honored, checkpoint-return on cap); a `.bak-specialistops` backup exists before any future definition patch.
---
