# Drizzle kit generate writes a stray migration dir and leaves migration.gen.ts stale

- 2026-09-29, opencode repo (packages/core)
- GOTCHA: `bun drizzle-kit generate` (config `packages/core/drizzle.config.ts`, `out: "./migration"`) writes new files into a stray `packages/core/migration/` directory and does NOT update the real consumer `packages/core/src/database/migration.gen.ts`. Adding a table to `packages/core/src/session/sql.ts` therefore ships UNMIGRATED: the new table does not exist at runtime and tests fail with `SQLiteError: no such table: session_followup` (41 tests).
- CORRECT COMMAND: from `packages/core` run `bun run script/migration.ts`. It regenerates `migration.gen.ts` (plus `schema.gen.ts` / `schema.json`) in place.
- CLEANUP: delete the stray `packages/core/migration/` directory that drizzle-kit leaves behind.
- ACCEPTANCE GATE: `migration.gen.ts` gains the new CREATE TABLE entry; the table exists in the live DB (`sqlite3 -readonly ~/.local/share/opencode/opencode.db ".schema session_followup"` prints it); no stray `packages/core/migration/` dir remains.
