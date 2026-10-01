# Settings tabs crash on provider-scoped hooks — typecheck cannot see provider availability

- **Date**: 2026-10-01T16:22:06+0800
- **Type**: lesson

## What happened

A settings-v2 tab swapped a provider-free source for the directory-scoped useSync() hook; every open of Settings then threw 'SDK context must be used within a context provider' at render and killed the dialog. Same class as the earlier Node-global renderer crash: compiles green, dies at runtime. Fix: fetch directory data with a provider-free createResource via serverSdk, mirroring the skills resource in the same file.

## Root cause / fix

grep -nE 'useSync\(|useSession\(' packages/app/src/components/settings-v2/*.tsx prints nothing; bun typecheck exit 0 from packages/app; app relaunched and the tab renders.
