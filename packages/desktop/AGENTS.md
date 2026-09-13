# Desktop package notes

## Building a production desktop app (`dist/mac-arm64/OpenCode.app`)

1. Confirm the user means the desktop app, not the CLI binary — the app never loads `~/.opencode/bin/opencode`; it runs its own server baked into `Resources/app.asar`. Check `ps aux | grep -i opencode` first (2026-08-31: rebuilding the CLI did not update the app; hours lost).
2. `OPENCODE_CHANNEL=prod bun run build` — bakes the channel into the server bundle in `out/`. `package:mac` does NOT rebuild; it packages whatever is already in `out/`, so skipping this step silently bundles a stale build.
3. `OPENCODE_CHANNEL=prod bun run package:mac` — produces `.app`/`.dmg`/`.zip`.
4. Acceptance gate: `verify-prod.ts` must print `✅ Verified <channel> build: ... embeds channel "<channel>" and uses <db>`. Never skip — dev and prod builds are visually identical; only this output proves which DB the app connects to (prod → `opencode.db`, else `opencode-<channel>.db`).

## Learnings

**CLI rebuild presented as a prod app update (2026-08-31).** Symptom: `~/.opencode/bin/opencode` was rebuilt and called "prod updated", but the user runs `packages/desktop/dist/mac-arm64/OpenCode.app`; the running `Resources/app.asar` had zero broker strings and `out/` was 11h stale. Root cause: this AGENTS.md was never read and no `ps aux | grep -i opencode` was run before choosing a build target, so the wrong artifact was built and the done-claim was false. Fix: run `ps aux | grep -i opencode` FIRST to see what is actually running; then `OPENCODE_CHANNEL=prod bun run build` (from `packages/desktop/`) before `OPENCODE_CHANNEL=prod bun run package:mac`; confirm with `verify-prod.ts` using `APP_DIR` plus `strings .../app.asar | grep` for the broker markers. Gate: `verify-prod` prints `✅ prod` against `opencode.db` AND `strings app.asar` shows `secret://project`.
