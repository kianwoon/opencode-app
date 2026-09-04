# Desktop package notes

## Building a production desktop app (`dist/mac-arm64/OpenCode.app`)

1. Confirm the user means the desktop app, not the CLI binary — the app never loads `~/.opencode/bin/opencode`; it runs its own server baked into `Resources/app.asar`. Check `ps aux | grep -i opencode` first (2026-08-31: rebuilding the CLI did not update the app; hours lost).
2. `OPENCODE_CHANNEL=prod bun run build` — bakes the channel into the server bundle in `out/`. `package:mac` does NOT rebuild; it packages whatever is already in `out/`, so skipping this step silently bundles a stale build.
3. `OPENCODE_CHANNEL=prod bun run package:mac` — produces `.app`/`.dmg`/`.zip`.
4. Acceptance gate: `verify-prod.ts` must print `✅ Verified <channel> build: ... embeds channel "<channel>" and uses <db>`. Never skip — dev and prod builds are visually identical; only this output proves which DB the app connects to (prod → `opencode.db`, else `opencode-<channel>.db`).
