# experimental_repairToolCall rewrote unknown tools to `invalid`, masking the real error

- **Date**: 2026-10-07
- **Type**: lesson
- **Area**: packages/opencode/src/session/llm.ts + session/llm/request.ts (V1 LLM loop)

## What happened

computer-aid hit the misleading error `Model tried to call unavailable tool 'invalid'. Available tools: bash, cua_batch, ...`. Live evidence (opencode.db part `prt_112868d6c0014rcxLpoNSCaqU9`, 2026-10-06 18:42): the model actually called `cua-driver_get_accessibility_tree` — a tool that IS in computer-aid's `owned_tools` but was NOT registered at that moment (the `cua-driver` MCP daemon only started at 22:56 that day). So the AI SDK raised `NoSuchToolError` for the real tool.

The error named `invalid` because of the repair chain:
1. The AI SDK (`ai@6.0.168`) calls `experimental_repairToolCall` on `NoSuchToolError` OR `InvalidToolInputError`.
2. The old hook in `llm.ts` unconditionally rewrote ANY repair-eligible call to `toolName: "invalid"`.
3. The SDK then re-parses the repaired call against the SAME tools map (`tools: prepared.tools`). But `resolveTools` (request.ts) had already filtered `invalid` out via the agent's exact `owned_tools` allowlist.
4. The re-parse threw a SECOND `NoSuchToolError` naming `invalid`, which the SDK's outer catch surfaced as the tool-error — discarding the truthful "unavailable tool '<realName>'" message.

The `invalid` tool is a registered catch-all (tool/registry.ts) excluded from `activeTools` (llm.ts) so the model never sees it — but it was ALSO subject to the `owned_tools` allowlist, breaking the invariant the repair relied on.

## Root cause / fix

The repair hook must never rewrite a call to a tool that is absent from the tools map, and must not conflate "unknown tool NAME" with "invalid ARGUMENTS". Fix (2026-10-07): extracted `makeRepairToolCall(tools)` in `request.ts`, wired via `LLMRequestPrep.makeRepairToolCall(prepared.tools)`. It returns `null` for any non-`AI_InvalidToolInputError` (so the SDK rethrows the original, truthful error) AND for an argument error when `tools["invalid"]` is undefined; only a genuine `AI_InvalidToolInputError` with `invalid` present is rewritten to `invalid`. Lowercase-recovery branch preserved.

SDK facts (ai@6.0.168): `NoSuchToolError.name === "AI_NoSuchToolError"`, `InvalidToolInputError.name === "AI_InvalidToolInputError"`; `ToolCallRepairFunction` returns `Promise<LanguageModelV3ToolCall | null>`; in `parseToolCall`, `if (repairedToolCall == null) throw error` rethrows the ORIGINAL error.

## Acceptance gate

- `bun test test/session/llm-repair-tool-call.test.ts` (from packages/opencode): unknown-tool→null; arg-error+invalid→rewrite to `invalid`; arg-error-no-invalid→null; mis-cased→lowercase. 2 of the 4 fail against the old unconditional-rewrite code, so the test is a real regression guard.
- `bun typecheck` exits 0 from packages/opencode.
- Symptom check: a subagent calling an unregistered tool now yields `Model tried to call unavailable tool '<realName>'. Available tools: ...`, never `'invalid'`.
