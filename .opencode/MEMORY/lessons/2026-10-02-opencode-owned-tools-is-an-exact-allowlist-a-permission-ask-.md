# opencode owned_tools is an exact allowlist; a permission ask blocks a subagent forever

- **Date**: 2026-10-02T02:33:55+0800
- **Type**: lesson

## What happened

computer-aid's prompt drove the GUI through the cua-driver_* MCP tools and its permission granted cua-driver_*, but its owned_tools listed only cua_batch - so the granted tools were never offered to the model (silent no-op). owned_tools is an exact-name allowlist with NO wildcards (packages/opencode/src/session/llm/request.ts:229, owned.includes(k)). Separately, a permission ask in a non-interactive subagent blocks indefinitely: packages/opencode/src/permission/index.ts:119-127 registers the request in pending, publishes Event.Asked, and suspends on Deferred.await - no auto-deny, no parent propagation, only scope teardown fails it (RejectedError). Symptom: subagent runs die mid-run with the bare string 'Tool execution aborted' and no denying rule named.

## Root cause / fix

owned_tools must list every tool name the agent is meant to call - enumerate MCP tool names from the driver itself (e.g. cua-driver list-tools; the local HTTP API exposes no MCP catalog route) - and never rely on a wildcard. Do NOT use ask in a subagent agent-block: use explicit allow/deny (Rule keys stay bare strings; action-only keys todowrite/question/webfetch/websearch/doom_loop must stay bare strings too). Gate: python3 -c "import json;json.load(open('$HOME/.config/opencode/opencode.json'))" exits 0 AND the agent's owned_tools contains the exact names its permission grants; external config edits need a restart.
