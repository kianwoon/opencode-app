# Direct input for known targets — never run a find-loop to execute (2026-10-14)

**Lesson (root cause of the 7×6 "minutes for four clicks" failure):**
The AX-walk + JEV loop is a *search* engine: it earns its keep only when a target
must be DISCOVERED (e.g. "which of System Settings' 51 unlabeled sidebar rows is
Appearance?"). Using it to execute an ALREADY-KNOWN action (a keystroke sequence,
a click on a visible control) means paying a whole-UI read before every event.

Measured on Calculator "7 × 6":
- AX + probe + decide + walk-verify path: 60–120 s (probe pass ~50 s, whole-app AX
  walk 40–116 s/step), aborted by user before completion; several runs never
  emitted a single step.
- Direct input (`--keys "7*6="`): **1.235 s total**, clipboard-verified result `42`.

**Rule:** target known → act immediately. Search only to FIND.
- Key-driven apps: keystrokes (`System Events keystroke`, ~150 ms cadence).
- Visible control with valid bounds: genuine pointer click (cliclick `c:x,y`),
  which is also the user-visible action.
- Verify cheaply: never a full re-walk — e.g. Cmd+C → `pbpaste` compare (Calculator
  copies its display), or a window-signature read. Full AX walk ONLY on evidence
  of change (title/window count moved, act failed) or when the target is unknown.
- Complexity is for the unknown case; the happy path must be simple.

**Artifacts:**
- `~/.config/opencode/bin/agent-toolkit/jev-fast-input.ts` — direct input for known
  targets (`--keys`, `--click`, optional `--verify-clipboard`); refuses
  credential-length payloads.
- **RETIRED 2026-10-14 (deleted):** `jev-nav-spike.ts` was the FIND path (AX eyes → JEV decide → act → verify). Its per-step whole-tree re-walk cost 40–116 s/step; the driver's own AX surface (`get_window_state` → `element_token`) superseded it and the file was removed. Find/refresh decisions now run through the driver + `ax-refresh-policy.ts`.

**Acceptance gate:** any computer-use task whose target is already known must
complete in <2 s of harness overhead without an AX walk; a run that reads the whole
UI before a known keystroke/click FAILS the gate.

**Anti-hardcode note:** the rule is general (known-target vs unknown-target), not
Calculator-specific — Calculator is only the fixture that exposed it.
