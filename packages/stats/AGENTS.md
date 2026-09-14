# OpenCode Stats

Stats is a separate site from the console. Runtime, database, and domain services live in `core`; the SolidStart website lives in `app`; deployable Lambda entrypoints live in `server`.

## Packages

- `app`: SolidStart frontend/site (`@opencode-ai/stats-app`).
- `core`: Effect services, app config, Drizzle schema/migrations, and stats domains (`@opencode-ai/stats-core`).
- `server`: Bun server + Firehose ingest (`@opencode-ai/stats-server`).

## Commands

- `bun run dev:stats` from the repo root starts the SolidStart app.
- `bun run --cwd packages/stats/app typecheck` typechecks the site.
- `bun run --cwd packages/stats/core typecheck` typechecks the Effect/database package.
- `bun run --cwd packages/stats/server typecheck` typechecks the server package.
- `bun run --cwd packages/stats/server start` runs `src/server.ts` locally.

## Deps direction

- `app` → `core` (+ workspace `ui`). `server` → `core`. `core` depends on neither. Never add a `core` → `app`/`server` import.
- `server` has no test script; do not invent one. Anything testable belongs in `core`.

## Inherited rules

- Style, Effect patterns, no-mocks, and testing rules come from the root `AGENTS.md` — do not duplicate them here.
- Note this tree has no root-level `package.json`: commands above target each sub-package via `--cwd` or `dev:stats` from the repo root.
