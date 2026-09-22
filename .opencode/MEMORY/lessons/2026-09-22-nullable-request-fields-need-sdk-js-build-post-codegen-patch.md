# Nullable request fields: SDK gen needs the build.ts post-codegen patch
- Gotcha: accepting null in an HttpApi request field (session update `time.archived` → NullOr) does NOT make `packages/sdk/js/src/v2/gen/types.gen.ts` nullable by itself — the app fails typecheck sending `archived: null` even after codegen exits 0.
- Fix: `bun ./script/build.ts` FROM packages/sdk/js applies post-codegen regex patches (types.gen.ts SessionUpdateData + sdk.gen.ts update: `archived` → `number | null`, throws if the regex misses). Never hand-edit gen files; never widen app-side types — remove the widening instead.
- Acceptance gate: `archived?: number | null` in types.gen.ts SessionUpdateData, packages/opencode `bun typecheck` exit 0, packages/app `bun typecheck` exit 0.
