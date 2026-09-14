# Desktop app vs CLI build target (2026-09-14)

## Gotcha
A CLI rebuild is NOT a desktop app update. The desktop app runs its own server
baked into `Resources/app.asar` inside `packages/desktop/dist/mac-arm64/OpenCode.app`
and never loads `~/.opencode/bin/opencode`. Dev and prod bundles are visually
identical, so a stale `out/` silently ships.

## Fix
1. `ps aux | grep -i opencode` FIRST — see what the user actually runs.
2. Desktop bible: `packages/desktop/AGENTS.md`.
3. From `packages/desktop/`: `OPENCODE_CHANNEL=prod bun run build` (not optional —
   `package:mac` just packages whatever is in `out/`).
4. `OPENCODE_CHANNEL=prod bun run package:mac` → `.app`/`.dmg`/`.zip`.
5. Run `verify-prod.ts`.

## Acceptance gate
- `verify-prod.ts` prints `✅ Verified <channel> build: ... embeds channel "<channel>" and uses <db>` (prod → `opencode.db`).
- `strings .../app.asar | grep -q 'secret://project'`.
- Built `.app` mtime is newer than the last source change.
