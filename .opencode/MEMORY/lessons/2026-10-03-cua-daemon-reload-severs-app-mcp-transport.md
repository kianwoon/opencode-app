# cua-daemon-reload-severs-app-mcp-transport

- **Date**: 2026-10-03T13:40:45+0800
- **Type**: lesson

## What happened

Reloading the cua-driver LaunchAgent daemon (launchctl bootout + bootstrap to apply a flag change such as removing --no-overlay) severed the desktop app's existing cua-driver MCP transport — every driver call returned 'Not connected' — while the daemon itself was running healthy on the new args. A verification flight launched in the window between the daemon reload and the app restart therefore aborted on both of its driver-side assertions, and the config change could not be probed at all until the app restarted.

## Root cause / fix

Sequence driver-runtime config changes as ONE unit: edit the configs (opencode.json MCP registration + LaunchAgent plist), reload the daemon, THEN restart the desktop app in the same window — the app restart is what re-spawns the MCP transport; never fly driver-dependent verification between the reload and the restart. Acceptance gate: a fresh post-restart driver call returns a real response (not 'Not connected') before any driver-dependent flight is launched.
