# NEVER capture the whole desktop (2026-10-13, user directive)
- `screencapture -x` full-screen captures grab the user's entire desktop — privacy violation, user explicitly forbade it.
- Verification must be URL/state-based (e.g. tab URL via Brave AppleScript), NOT screenshot-based, unless the user explicitly asks for a capture.
- If a capture is ever required, window-scoped of the named target app only, and only with explicit user approval first.
- Acceptance gate: zero full-desktop screencapture invocations in any session; proof requests answered with app-state queries, not images.
