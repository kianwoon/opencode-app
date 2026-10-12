# macOS TCC attributes Accessibility to the real executable, not a console-script entrypoint: uv-installed CLIs (e.g. cua) must grant Accessibility on the venv interpreter (~/.local/share/uv/tools/<tool>/bin/python), or the daemon process reads empty a11y trees (0 nodes) while window listing still works. Diagnosis signature: window ls OK + a11y tree empty on ALL windows (old and new) = attribution failure, not per-window staleness. Re-grant required if uv upgrades the tool. After granting, restart the daemon before re-testing. Acceptance gate: a11y tree on a window CREATED AFTER daemon start returns >0 nodes; daemon reads ~1.1-1.2s vs embedded ~2-5s.

- **Date**: 2026-10-12T20:51:34+0800
- **Type**: lesson

## What happened



## Root cause / fix


