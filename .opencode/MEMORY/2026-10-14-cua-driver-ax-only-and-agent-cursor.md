# cua-driver AX-only path + agent cursor (2026-10-14, live-verified)

**Headline:** the right way to click is the cua-driver's AX surface with its session *agent cursor* — not AppleScript/System Events, not cliclick, not coordinate clicks.

**1. The driver reads labels System Events cannot.**
`get_window_state {pid, window_id}` returns a structured `elements` array with `label` + `element_token`. Calculator — which AppleScript reported as label-less on all six attributes — comes back as `"7" "8" "9" "Multiply" "Delete" "All Clear" …`; System Settings sidebar comes back with identifiers. **Check the driver's AX tree BEFORE building probe-learning or grid heuristics.**

**2. AX clicks move nothing.**
`click {pid, element_token}` performs an AXPress. Controlled hands-off test: real pointer `(4215,1895)` **before == after**, dx=0 dy=0 (~20 s, 5 calls). No `move_cursor`, no coordinate click, no cliclick needed.

**3. Tokens require a persistent session lease.**
Snapshots/element_tokens are session-scoped. One-shot `cua-driver call` invocations refuse with `stale_element_token … has no current snapshot` (even back-to-back). Use the **MCP transport** (computer-aid), which holds the lease.

**4. The agent cursor is a drawn overlay — and it IS visible (user-confirmed).**
`set_agent_cursor_enabled {"enabled":true}` + `set_agent_cursor_motion {glide_duration_ms, effects}`. User confirmed seeing it during the Calculator demo. Caveat: `get_agent_cursor_state` returns **no motion/visibility fields** — telemetry is blind, so verify visually, never by that endpoint.
Defaults: `glide_duration_ms 0.0` (instant), `timing native`, `style signature_arc`, effects glow+ripple+squish, trail off, `idle_hide_ms 15000`. Persist via `cua-driver config set cursor.motion.*`; per-session via `set_agent_cursor_motion`.
Custom themes are unavailable on this install (`cua-cursor-theme` sidecar missing).

**5. Acceptance gate (use verbatim):** the action completes via `element_token`/`invoke_menu`; the user SEES the drawn cursor; `get_cursor_position` is byte-identical before/after. Any path that moves or clicks the real pointer FAILS.

**Anti-hardcode note:** the rule is "AX first, driver AX tree before any heuristic" — Calculator and System Settings are only the fixtures that exposed it.

**CONFIRMED (2026-10-14, user observation — supersedes an earlier wrong inference):** the drawn agent cursor **IS visible at the target of an AX `element_token` click** (user saw the blue cursor land on the LinkedIn "Notifications" link). An earlier claim that "AX token clicks do not animate the cursor" was WRONG — it was inferred from `get_cursor_position` staying byte-identical, which proves only that the REAL pointer did not move. The overlay is invisible to telemetry (`get_agent_cursor_state` returns no motion/visibility fields); **verify visually, never by pointer position**.
