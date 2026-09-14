# 2026-09-13: prod build copy required after any UI/config change

**Gotcha**: Editing `packages/app` source is NOT reflected in the running binary until you
run the vite build AND re-embed it. `bun run generate` alone is insufficient — it does not
rebuild `dist/` (see `packages/opencode/AGENTS.md:112-114`). Observed: `app/dist` stale
(Sep 12) vs source (Sep 13); the deployed binary kept serving old UI. Second occurrence of
this miss, hence mandatory lesson.

**Secondary gotcha**: stale `tsconfig.tsbuildinfo` makes `tsc` skip emit while reporting
success — delete it if a build silently produces no output.

**Fix (ordered, run from repo root)**:
1. `cd packages/sdk/js && bun run build` — rebuild SDK dist (workspace symlink target).
2. `cd packages/app && bun run build` — rebuild the embedded UI (vite → `app/dist`).
3. `cd packages/opencode && OPENCODE_CHANNEL=dev bun run script/build.ts --single` — re-embed.
4. If any tsc step skips emit, delete the stale `tsconfig.tsbuildinfo` and rerun that step.

**Acceptance gate**:
- `app/dist/index.html` mtime > source mtime.
- Built `dist/index.html` contains the new strings/changed assets.
- Binary mtime is newer than the dist build.
- `strings <binary>` hits the new UI strings (embed verified).

**Rule for Brain**: every UI/config change plan MUST include the prod-build-copy step
(sdk build → app vite build → script/build.ts embed) before claiming done.
