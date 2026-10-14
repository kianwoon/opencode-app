# cua-driver cannot reach the Wallpaper pane's Black swatch (2026-10-14, measured)

**Symptom:** System Settings → Wallpaper → the "Black" color swatch cannot be scrolled to,
seen, or selected through the cua-driver (0.35.2, com.trycua.driver).

**Measurements (all raw driver output):**
- Pane window band: `{x:4829, y:504, w:740, h:1362}` → visible y 504–1866.
- Black swatch: `AXButton 'Black' {x:5199, y:2060.5, w:48, h:48}`, parent `AXOpaqueProviderGroup 'Colors'`
  → ~194 px BELOW the visible band; `isRemote` element in a virtualized custom-drawn grid.
- The window exposes **no** `AXScrollArea`/`AXScrollBar`
  (roles: `AXButton 138, AXRow 39, AXStaticText 11, AXOpaqueProviderGroup 10, AXWindow 1, …`).
- Three synthetic scrolls dispatched (background wheel ×10, background keystroke page ×5, foreground wheel ×10)
  → **zero geometry change** (y 2060.5 → 2060.5); driver labels them `effect: unverifiable`, `route: synthetic_events`.
  Real pointer byte-identical before/after `(3696,1844)`.
- The swatch declares only `["AXScrollToVisible","AXShowMenu"]` (no AXPress).
- `click {element_token, action: press}` (default) → `⚠️ Element does not advertise AXPress … may have been a no-op`.
- `click {element_token, action: show_menu}` → `✅ Performed AXShowMenu`, but functionally inert:
  element count 212 before/after, no popup window (`listWindows` unchanged), no tree delta.
  Wallpaper NOT changed (previously active wallpaper stayed selected).

**Root gap:** the driver's AX action set is a fixed curated list —
`click.action` = `press, show_menu, pick, confirm, cancel, open, show_alternate_ui, show_default_ui`.
There is **no element-declared pass-through**: an action the element itself exposes but the driver
does not list (here `AXScrollToVisible`) cannot be invoked at all. The general fix is exactly
element-declared capability — read `AXUIElementCopyActionNames` on the live element and allow performing
any name in that set (the driver even has the machinery: `Observe.actionNames` analog + a raw
`AXUIElementPerformAction`).

**Usage lessons (same day):**
- Batch with `run_steps` / `run_script`: one probe = 7 driver calls in **3.6 s**. Per-step
  act→observe loops cost ~12 min and get killed by the user's 20 s hard-stop.
- `get_window_state` tokens are session-scoped and stale after each snapshot — always re-read.
- The MCP transport holds the lease; bare CLI calls hit `stale_element_token`.

**Target-identification rule (from the same incident):** before deploying anything into an app bundle,
read its identity — `codesign -dvv <app>` / `CFBundleIdentifier`. `/Applications/CuaDriver.app` is
trycua's product (`com.trycua.driver`, Developer ID "Cua AI, Inc."); an unrelated app's binary must
never be copied over it.

**Acceptance gate:** a swatch whose declared actions are X must be operable by the driver invoking X
(no hardcoded action list), and a Wallpaper-pane probe must complete in one batched call under 20 s.
