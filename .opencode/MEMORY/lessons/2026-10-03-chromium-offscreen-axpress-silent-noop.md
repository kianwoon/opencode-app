# chromium-offscreen-axpress-silent-noop

- **Date**: 2026-10-03T14:26:43+0800
- **Type**: lesson

## What happened

On Chromium web content, cua-driver AXPress on an element outside the viewport reports success (performed AXPress) but performs nothing — the post-action accessibility tree was byte-identical (an Add Work Experience button that clones a DOM block never cloned, 0/1 blocks after a confirmed-looking press). The driver does not verify that the AX action landed, so an ok line is NOT evidence. LinkedIn nav AXPresses only worked because those elements were visible. A follow-up foreground pixel click at the scrolled-into-view coordinate also reported ok with no effect — root cause not yet isolated (candidates: window-vs-screen coordinate space, or the newly enabled cursor overlay intercepting foreground clicks).

## Root cause / fix

Before AXPress on web content, ensure the element is in the viewport (targeted scroll), take a FRESH snapshot so tokens reflect the new layout, press, then VERIFY by diffing the tree (element count, value, or URL) — never treat the ok line as activation. Acceptance gate: a topology or value diff proving the action landed; a byte-identical post-action tree means the action was a no-op regardless of ok.


## SUPERSEDED — FINAL RESOLUTION (2026-10-03)
The causal claim in this lesson was FALSE. After the page fixture was fixed (self-referencing insertAdjacentElement threw HierarchyRequestError on the detached clone — uncaught, so no clone ever happened), the IDENTICAL AXPress call cloned the block correctly on the first try. The driver and its AXPress were exonerated entirely. The correct, surviving lesson is 2026-10-03-identical-failure-across-all-gui-input-mechanisms-means-susp: when ALL input mechanisms (AX offscreen, pixel foreground, AX on-screen fresh token — AND a human click) fail identically, suspect the PAGE, not the driver, and run the human-click discriminator early.