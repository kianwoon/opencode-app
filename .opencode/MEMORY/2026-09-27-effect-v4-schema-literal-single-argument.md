---
# Effect 4.0.0-beta Schema.Literal takes ONE argument

**Symptom (2026-09-27):** `Schema.Literal("a", "b")` (the Effect v3 multi-value form) fails typecheck in this repo.

**Root cause:** this repo pins effect@4.0.0-beta.83 (`patches/effect@4.0.0-beta.83.patch`); its `Schema.Literal` accepts exactly one value. Multi-value enums must be `Schema.Union` of single-value literals.

**Fix:** build enums as `Schema.Union([Schema.Literal("a"), Schema.Literal("b"), ...])`; reuse the local `enumeration(...)` helper in `packages/opencode/src/tool/cua-batch.ts` instead of inlining many single-literal unions per enum field.

**Acceptance gate:** `bun typecheck` exit 0 from `packages/opencode` with unions built this way.
---
