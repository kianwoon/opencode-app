# chromium-web-button-activation-ok-is-not-evidence-supersedes-offscreen-theory

- **Date**: 2026-10-03T14:31:48+0800
- **Type**: lesson

## What happened

CORRECTS AND SUPERSEDES the lesson chromium-offscreen-axpress-silent-noop (its offscreen-visibility attribution is DISPROVEN). On a Chromium web page, a 'Add Work Experience' button failed to activate through THREE distinct mechanisms, all reporting ok with zero DOM mutation (tree stayed 71 elements, one .exp block, verified by query count and screenshot): (1) background AXPress offscreen, (2) foreground pixel click at a scrolled-in coordinate, (3) on-screen AXPress with a freshly re-indexed token. Visibility is NOT the discriminator. An AXPress ok line on Chromium web content is not evidence of activation, period. The page's own cloneNode handler could not be exonerated or convicted because no working activation path existed to exercise it, and AppleScript-JS was disabled in the browser.

## Root cause / fix

Treat every web-content press as unproven until a topology/value/URL diff confirms it. For button activation AX cannot land, escalate along the action ladder: pixel click (then VERIFY), then the CDP page/browser tools — or isolate page-bug-vs-driver-bug in seconds with a HUMAN click on the visible button before further automation attempts. Acceptance gate: a clone/mutation diff (element-count change), never an ok line.


## RESOLUTION (2026-10-03, human-click discriminator)
The user clicked the button manually: nothing happened — the page fixture itself was the bug. The handler called `c.insertAdjacentElement(afterend, c)` (SELF-referencing: c is a DETACHED clone with parentNode null), which throws HierarchyRequestError uncaught before any insertion. All three automation mechanisms were dispatching real clicks into a broken handler; the driver was exonerated in seconds once a human tried the same click. Fixture fixed to insert after the in-document sibling (`last.insertAdjacentElement(afterend, c)`). Two reusable patterns: (1) run the human-click discriminator BEFORE escalating to tooling/driver bugs — it exonerated the driver instantly; (2) `insertAdjacentElement` called on a detached node with itself as the argument throws — insert relative to an in-document sibling.

## SUPERSEDED — FINAL RESOLUTION (2026-10-03)
The causal claim in this lesson was FALSE. After the page fixture was fixed (self-referencing insertAdjacentElement threw HierarchyRequestError on the detached clone — uncaught, so no clone ever happened), the IDENTICAL AXPress call cloned the block correctly on the first try. The driver and its AXPress were exonerated entirely. The correct, surviving lesson is 2026-10-03-identical-failure-across-all-gui-input-mechanisms-means-susp: when ALL input mechanisms (AX offscreen, pixel foreground, AX on-screen fresh token — AND a human click) fail identically, suspect the PAGE, not the driver, and run the human-click discriminator early.