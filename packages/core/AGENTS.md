# packages/core

## Import order: filesystem TDZ

`src/filesystem/filesystem.ts` dereferences `FileSystemSearch.node` at module-evaluation time
(`deps: [FSUtil.node, Location.node, FileSystemSearch.node]`, filesystem.ts:117). An import graph
that enters `search.ts` before `filesystem.ts` therefore crashes with
`ReferenceError: Cannot access 'node' before initialization` — the namespace object is still in its
temporal dead zone when filesystem.ts evaluates its `node` deps.

Fix: import `"../src/filesystem"` (or follow the app's entry order) before any filesystem-adjacent
module in tests and entry points. `test/repo-symbols.test.ts` and
`test/filesystem-search-list.test.ts` both carry this import-order comment.

Acceptance: `bun typecheck` exits 0 from `packages/core`; the affected tests pass.

- New tables in `packages/core` require `bun run script/migration.ts` from `packages/core` — NOT `bun drizzle-kit generate`, which writes a stray `migration/` dir and leaves `migration.gen.ts` stale, shipping the table unmigrated. Acceptance gate: `migration.gen.ts` gains the entry, the table exists in the live DB, no stray `migration/` dir.
