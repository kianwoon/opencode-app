# Lesson — non-production builds shipped twice: the channel, not the version string, proves production

Date: 2026-10-31
Scope: project (`packages/script`, `packages/desktop/script`, any rebuild of CLI/desktop artifacts)

## What happened
Two rebuilds of the desktop app and CLI were declared "production" while they were preview builds:
- `bun run --cwd packages/cli build` with no env → `CHANNEL = <git branch>` = `main` → `IS_PREVIEW = true` → version `0.0.0-main-<timestamp>` → that binary was installed over `~/.opencode/bin/opencode`.
- `bun run --cwd packages/desktop pack` with no env → `resolveChannel()` defaults to `"dev"` → `OpenCode Dev.app`.
- `OPENCODE_CHANNEL=prod` is NOT production either: `packages/script/src/index.ts` only treats the literal channel `latest` as non-preview.

## Rule (binding for this repo)
Production builds MUST pass both env vars, or they are previews:
```
OPENCODE_CHANNEL=latest OPENCODE_VERSION=$(node -p "require('./package.json').version") \
  bun run --cwd packages/cli build
OPENCODE_CHANNEL=latest OPENCODE_VERSION=$(node -p "require('./package.json').version") \
  bun run --cwd packages/desktop pack
```
- `latest` ⇒ `IS_PREVIEW=false`, `VERSION = OPENCODE_VERSION` (and `latest` throws if `OPENCODE_VERSION` is missing).
- Desktop `resolveChannel()` maps `latest` → `prod` appId; `prod`/`dev`/`beta` as the raw env value are all preview for `@opencode/script`.

## Verification gate (what NOT to do)
`CFBundleShortVersionString` comes from `package.json` and proves nothing about channel. Verify the CHANNEL:
- CLI: the binary's `--version` must equal the release version (e.g. `v2.2.4`), never `0.0.0-<channel>-<stamp>`.
- Desktop: check the appId (`ai.opencode.desktop` = prod; `.dev`/`.beta` suffixes = preview) AND that the build ran with `OPENCODE_CHANNEL=latest`.

## Use instead
`bun run script/rebuild-prod.ts` — sets the env, builds CLI + desktop, installs the CLI atomically, and prints the verified channel/version/appId for each artifact. It fails closed on a preview artifact.

## Acceptance gate
A rebuild is "done" only when the script exits 0 and prints `channel=latest` plus the release version for both artifacts.
