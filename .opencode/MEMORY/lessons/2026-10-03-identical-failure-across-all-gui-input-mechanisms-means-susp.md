# Identical failure across all GUI input mechanisms means suspect the PAGE, not the driver

- **Date**: 2026-10-03T14:43:54+0800
- **Type**: lesson

## What happened

Three different cua-driver input paths (background AXPress offscreen, foreground px click on-screen, foreground AXPress on a freshly-tokened VISIBLE element) all returned '[ok]' and all failed to mutate a browser page's DOM: 3 flights, ~15 calls, wrong root cause. I concluded 'AXPress on Chromium web content is not activation' and twice offered to write that to memory — which would have been actively harmful, since the driver was innocent.

## Root cause / fix

When every synthetic AND human-equivalent (px) input path fails identically, that symmetry is evidence AGAINST an automation-layer bug. The page's own handler was throwing: c.insertAdjacentElement('afterend', c) on a DETACHED clone throws HierarchyRequestError per DOM spec (insertAdjacentElement requires a non-null parent). A human clicking would have failed too. Rule: before blaming the input layer, read the page's event handler for a throw; verify by DOM diff (block count / value read-back), never by the transport's '[ok]'. Also: DOM node methods that require an attached node — insertAdjacentElement, insertBefore, appendChild on a fragment — fail on detached clones.
