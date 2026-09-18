# route selection beats route optimization (DOM/JS before macOS AX)

**Gotcha / symptom:** Filling forms / scraping / clicking web content via macOS
Accessibility (AX) rung repeatedly failed or crawled: HTML `<select>` options were
invisible (`Available [""]`), `contenteditable` values unreadable, value read-backs
unreliable. Hours were spent optimizing the AX path (43–185s per action, repeated
failures) instead of questioning whether AX was the right route at all.

**Root cause:** AX is designed for **native desktop UI**, not web DOM. Chromium/WebKit
render tree state (select options, contenteditable, live input values) is not faithfully
projected through the AX layer, so no amount of tuning makes it reliable. The cheapest
correct route for web content is DOM JavaScript, not the GUI/AX surface.

**Fix / pattern:** For web content (forms, scraping, clicks) use DOM JS first —
`osascript -e 'tell application "Brave Browser" to execute javascript "..."'` (or CDP
`page` tool). Reserve AX tools for native desktop windows only. Pick the cheapest route
**first** (headless/DOM/API before GUI/AX); optimization cannot rescue a wrong route.

**Acceptance evidence:** DOM route filled the same form 9/9 fields in **10.9s across 4
calls**, no focus steal, standard mode, no security changes required — versus the AX
route's 43–185s per action with repeated failures. Route selection, not route
optimization, was the whole win.
