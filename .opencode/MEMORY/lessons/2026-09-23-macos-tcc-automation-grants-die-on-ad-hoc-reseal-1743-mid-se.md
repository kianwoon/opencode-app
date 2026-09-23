# macos tcc automation grants die on ad-hoc reseal 1743 mid-session after prod rebuild

- **Date**: 2026-09-23T14:39:25+0800
- **Type**: lesson

## What happened

After a prod desktop rebuild with ad-hoc re-seal (codesign --force --deep --sign -), osascript Apple Events to Brave began failing -1743 Not authorized mid-session, although identical calls succeeded earlier the same session. The ad-hoc signature change invalidates the TCC assignment and silently revokes the grant; the downstream agent reported NO_OBS and looked like a code bug.

## Root cause / fix

On -1743, check System Settings > Privacy & Security > Automation (host app to target browser toggle) FIRST — one probe distinguishes permission from code instantly: osascript -e 'tell application "Brave Browser" to execute (tab 1 of front window) javascript "1+1"' returns 2 when granted, -1743 when revoked. No code change can fix a TCC revocation. Acceptance gate: the probe returns 2 after the user re-grants; only then re-run the automation.
