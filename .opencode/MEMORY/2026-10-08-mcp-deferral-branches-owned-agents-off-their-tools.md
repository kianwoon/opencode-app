# mcp-deferral-branches-owned-agents-off-their-tools

- **Date**: 2026-10-08T13:40+0800
- **Type**: lesson

## What happened

computer-aid subagent sessions always errored `Model tried to call unavailable tool 'cua-driver_list_apps'` while the MCP servers were healthy (HTTP `/mcp/inventory` showed cua-driver 58 + cua 138 tools connected in EVERY instance). The session's available set was exactly `owned_tools` minus every MCP tool — native custom tools (cua_batch, ui_run, jev_*) all present.

## Root cause / fix

MCP tool-search deferral (`packages/opencode/src/session/tool-search.ts`, `DEFAULT_THRESHOLD = 0.1` of context window) defers ALL MCP tool definitions into a compact catalog when total definition bytes cross the threshold — and this setup runs 228 MCP tools across 7 servers, so everything defers. Promotion back is via `find_tools`, but computer-aid's `owned_tools` allowlist did not include `find_tools`/`tool_search` — so an agent whose core surface IS MCP was left with zero promotion path: total stranding, not flakiness. Debug order that found it: (1) `ps` → server processes alive, (2) config `owned_tools` + `permission` both correct, (3) `/mcp/inventory?directory=...` → servers connected, (4) the available-set arithmetic → MCP class missing, (5) read the deferral planner. Fix: `"alwaysLoad": true` on the `cua-driver` server in opencode.json (bypasses deferral; `tool-search.ts` L16 "alwaysLoad servers bypass deferral entirely"). NOT hot-reloaded — needs app restart (config lesson).

## Acceptance gate

Fresh computer-aid session calls `cua-driver_list_apps` and gets a real tool response (not "unavailable tool"); session tool list includes the cua-driver tools inline. If a future owned agent's toolset silently shrinks by exactly one server's tools, check deferral BEFORE permissions: the inventory endpoint proves the server side, the owned-filter arithmetic proves the agent side.

## Gotcha

Any agent whose `owned_tools` centers on MCP tools MUST either own `find_tools` (promotion path) or have its server marked `alwaysLoad` — deferral + exact-match owned_tools + no promotion tool = permanent stranding that looks like a wiring bug but is a context-budget feature.
