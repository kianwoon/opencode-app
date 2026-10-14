# HARD LIMIT: no blocking operation may exceed 20 seconds (2026-10-14, user directive)

**User directive, binding, no exceptions:** if the user ever sees a command or wait
run longer than 20 seconds, they will hard-stop it. Do not launch anything that can
exceed 20 s of blocking time.

**What this forbids:**
- `sleep N` with N > 20 in any poll loop (measured violation: `sleep 80` was run
  without approval — user-corrected).
- Long-running foreground commands (full AX walks ~40–116 s, installs, builds run
  in the foreground).
- Any "wait and see" pattern that holds the user's turn open.

**What to do instead:**
- Prefer operations that complete in <20 s; if a task genuinely needs longer,
  do NOT block — split it, or tell the user the expected duration and let them
  decide before anything starts.
- Never buffer long output through a pipe (silence looks like a hang) — stream.
- One cheap status check per turn, not a sleep-then-check loop.

**Acceptance gate:** zero blocking operations >20 s in any session; a run that
cannot finish in 20 s is either pre-approved by the user with a stated duration, or
not started.

**Companion lessons:** `2026-10-14-direct-input-for-known-targets.md` (never use a
search loop to execute a known action), `2026-10-13-no-desktop-screenshots.md`
(never capture the whole desktop).
