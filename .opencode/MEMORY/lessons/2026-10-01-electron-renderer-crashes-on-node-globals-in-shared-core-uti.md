# Electron renderer crashes on Node globals in shared core utils

- **Date**: 2026-10-01T14:23:40+0800
- **Type**: lesson

## What happened

The app renderer imported the core Wildcard util whose match() read process.platform; ReferenceError inside a Solid memo (no error boundary) killed the whole render tree when the Settings Permissions tab opened. Bundler and typecheck do NOT catch Node-global references in renderer-bundled code.

## Root cause / fix

grep -n 'typeof process' packages/core/src/util/wildcard.ts shows the guard; both bun typechecks exit 0; bun test test/permission/next.test.ts green from packages/opencode; app relaunched and the Settings Permissions tab renders.
