# 2026-09-22 — AI SDK vendor sources absent from repo node_modules; verify usage semantics empirically

Pattern: checking `@ai-sdk/anthropic` or `@ai-sdk/openai-compatible` mapping code fails — the packages are NOT in repo-root `node_modules`, `packages/*/node_modules`, or `~/.bun/install/cache` globs (bundled into the desktop artifact), so vendor-semantics questions cannot be answered from source in this workspace.

Fix: answer vendor usage-semantics questions EMPIRICALLY from `~/.local/share/opencode/opencode.db` instead: per provider, compare `avg($.tokens.input)` against `sum($.tokens.cache.read)/turns`. Signature guide: input + cache_read ≈ raw prompt size → SDK reports inputTokens INCLUDING cached (opencode's subtraction at `packages/opencode/src/session/session.ts:366` is correct); implausible ~0 input on high-cache_read turns → double-subtraction (SDK reports inputTokens EXCLUDING cache).

Acceptance gate: at most ONE handoff iteration hunting SDK source in this workspace; then route the question to DB evidence or mark it explicitly UNKNOWN.
