# opencode MCP zero-tool mount: boot race + one-shot cache, fixed by lazy re-list

- **Date**: 2026-10-05
- **Type**: lesson
- **Commit**: d677dda14e (fix(mcp): lazy re-list for connected-but-empty catalogs; loud tools/list failures)

## Root cause (reproduced 3 boots)

An MCP server mounting while its `tools/list` fails or races is cached as **connected-with-empty-defs forever**:

- `mcp/index.ts:516/:529-553` — instance-scoped `InstanceState` cache populated **once at boot** (`s.defs[key] = result.defs!`)
- `mcp/catalog.ts:39` — `tools/list` errors swallowed into `undefined`, no log
- `mcp/index.ts:701` — `MCP.tools()` reads `s.defs` with no re-list (only a WARN)
- `config.ts:662` — `Config.invalidate()` never touches MCP state

Main sessions, resumed sessions, AND freshly-created subagents all read the same shared cache — so **no config change or app restart fixes it in-session**. Gotcha: `GET /mcp` status map says `connected` even when the catalog is empty — status is the *connection*, not the *catalog*.

## Fix (d677dda14e)

- `catalog.ts`: `defs()` takes clientName; `tools/list` failures log a WARN (fail-open kept)
- `mcp/index.ts`: `MCP.tools()` lazy re-lists via per-client `Effect.cachedInvalidateWithTTL` (5 min) when connected + empty + tools-capability, guarded by `s.clients[name] === client`; `tools/list_changed` handler shares the cached effect; disconnect paths drop the entry

## Verification

```bash
cd packages/opencode
bun test test/mcp/ test/session/tools.test.ts   # 75 pass / 0 fail incl.
                                                # "connected + empty defs → lazy re-list surfaces tools"
bun typecheck                                   # exit 0
```

## Corollaries

- Subagent tool surfaces derive from the **shared instance cache**, not a parent-session snapshot — fixing the cache fixes subagents too.
- A mount race zeroes the catalog **silently**: status `connected` + zero tools + zero log lines is the signature.
- `Effect.cachedInvalidateWithTTL` is the codebase-native dedupe/throttle (concurrent callers share one execution within the TTL).
