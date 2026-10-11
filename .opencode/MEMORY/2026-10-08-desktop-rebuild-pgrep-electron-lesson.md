# desktop-rebuild-watcher-lessons-pgrep-electron-quit-race

- **Date**: 2026-10-08T15:00+0800
- **Type**: lesson

## What happened

Arming a background script to rebuild `dist/mac-arm64/OpenCode.app` after app-quit failed THREE times: (1) nohup child died with the app's process-tree teardown; (2/3) `launchctl submit` watchers hung forever. Root cause stack: `pgrep -f <bundle path>` matches `chrome_crashpad_handler`, which outlives the app by design, so quit+relaunch inside its lifetime shows no gap — AND `pgrep -f` can NEVER match the Electron main process at all (Chromium rewrites its argv; `ps -axo args=` shows it, pgrep never finds it). Watcher generations under `launchctl submit` also overlap (KeepAlive default) and truncate shared logs.

## Root cause / fix

Two rules: (a) never use `pgrep -f` to find an Electron main process — use `ps -axo args=` anchored to `Contents/MacOS/<Binary>( |$)`; (b) never race a human quit — the deterministic pattern is a script that quits the app itself. Final discovery that mooted all of it: **electron-builder `--mac dir` works fine while the app is running** (APFS replaces bundle files; the running instance may die, which is harmless since the goal is replacement). Verify gates after packaging: `codesign --verify --deep` (an identity-signed build needs NO adhoc reseal), 8 `CodeResources` (4 helpers + 4 frameworks), `verify-prod.ts` prints `✅ Verified prod build`.

## Acceptance gate

Fresh `app.asar` mtime + `codesign --verify --deep` exit 0 + `verify-prod` ✅ line. Do not arm quit-watchers for desktop rebuilds; package live, then relaunch.
