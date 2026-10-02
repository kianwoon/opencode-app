# Duplicate JSON keys silently mask config writes - last key wins

- **Date**: 2026-10-02T23:21:54+0800
- **Type**: lesson

## What happened

Text-level edits to opencode.json created TWO owned_tools keys in one agent block; every json.load verification read the LAST (broad) key, so a correct focused write looked like it never landed and cost a failed quit-script-relaunch cycle; the running app's Settings commits re-serialize from memory and wipe duplicates, while external edits never stick while it runs

## Root cause / fix

Before text-editing JSON config, count key occurrences in the target block (expect 1); after writing, re-parse AND count raw key occurrences; treat the running app's Settings UI as the only authoritative writer
