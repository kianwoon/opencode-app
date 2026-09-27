---
# cua-driver schema truth is `describe <tool>`, never `list-tools`

**Symptom (2026-09-27, cua_batch implementation):** a typed wrapper needed the real actuator inputSchemas; `cua-driver list-tools` (v0.28.2) printed names + descriptions ONLY — no schemas, no `--json` flag.

**Root cause:** `list-tools` is a name/description index by design. The per-tool inputSchema lives behind `describe`. The older comment in `packages/opencode/src/jev/client.ts` ("Verified against `cua-driver list-tools`") is misleading for schema work — it verified tool NAMES, not shapes.

**Fix:** ground typed wrappers on `cua-driver describe <tool>` output (e.g. `cua-driver describe click`, `describe drag`, `describe set_value`).

**Acceptance gate:** wrapper variants generated from `describe` pass their tests — here `bun test test/tool/cua-batch.test.ts` (4/4) and `bun typecheck` exit 0 from `packages/opencode`.
---
