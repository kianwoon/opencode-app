# `package:mac` without OPENCODE_CHANNEL WIPES the running app's bundle (2026-10-03)

**Symptom.** `bun run package:mac` exited 0 and printed `signing file=dist/mac-arm64/OpenCode Dev.app` —
a build that looks fine but is neither the intended artifact nor the intended channel. Afterwards
`ls dist/mac-arm64/` held ONLY `OpenCode Dev.app`: the `OpenCode.app` the user was actually running
was **deleted from disk** while its process kept running.

**Root cause — two independent defects.**
1. `package.json` `package:mac` does NOT carry `OPENCODE_CHANNEL`; the env must be re-supplied per
   invocation. `electron-builder.config.ts:60-64` silently falls back to `dev`, so the productName
   becomes `OpenCode Dev` and the appId `ai.opencode.desktop.dev` — a **silent dev build, exit 0**.
   Only the signing line names the real target; READ IT.
2. electron-builder clears `directories.output`'s per-arch app dir before packaging. It deletes the
   bundle of the RUNNING app. macOS keeps the unlinked inode mapped, so the process survives and
   `ps` still shows it healthy — the disappearance is invisible until the user restarts.

**Fix.** Always `OPENCODE_CHANNEL=prod bun run package:mac:app` (the `dir` target: no dmg/zip,
faster, and produces exactly `dist/mac-arm64/OpenCode.app`). Confirm the product name in the signing
line BEFORE continuing. If `OpenCode.app` is already gone, re-run the prod package — never restart
the app to "fix" it.

**Verify-prod needs env + the real path.** It lives at `scripts/verify-prod.ts` (NOT `script/`), and
throws unless `OPENCODE_CHANNEL` **and** `APP_DIR` are both set:
`OPENCODE_CHANNEL=prod APP_DIR=dist/mac-arm64/OpenCode.app bun scripts/verify-prod.ts`.
A bare `bun script/verify-prod.ts` dies with `error: Module not found`.

**Acceptance gate.** (1) signing line reads `file=dist/mac-arm64/OpenCode.app`, not `OpenCode Dev.app`;
(2) `ls dist/mac-arm64/` shows `OpenCode.app`; (3) verify-prod prints
`✅ Verified prod build: <chunk> embeds channel "prod" and uses opencode.db`; (4) the user's app is
untouched — verify-prod proves the CHANNEL, not that the RUNNING process picked up the new bundle
(a live process keeps the old inode; only a user-initiated restart adopts the rebuild).