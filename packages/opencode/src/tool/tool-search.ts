import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { ToolSearch as SessionToolSearch } from "@/session/tool-search"
import * as Tool from "./tool"

export const TOOL_SEARCH_TOOL = "tool_search"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Words to match against tool names, server names, and descriptions. Use an exact `server_tool` key to promote a specific tool.",
  }),
})

const DESCRIPTION = `Search and load deferred MCP tools. When a session has many MCP tools, their full definitions are not loaded into context; only the catalog in this description is. Call this tool with a query matching a tool's name or purpose to load its full definition and make it callable for the rest of the session.`

/**
 * Deferred-MCP tool search. Registered only when deferral is active (see
 * session/tools.ts); the dynamic catalog is appended to its description at
 * registry time so the model can decide what to promote without any tool
 * ever being hardcoded.
 */
export const ToolSearchTool = Tool.define(
  TOOL_SEARCH_TOOL,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("ToolSearch.execute")(function* (params: { query: string }, ctx: Tool.Context) {
        const cfg = yield* config.get()
        const all = yield* mcp.tools()
        const result = SessionToolSearch.search({
          sessionID: ctx.sessionID,
          query: params.query,
          tools: all,
          mcpConfig: (cfg.mcp ?? {}) as Record<string, unknown>,
        })
        return {
          title: `tool_search(${params.query})`,
          metadata: { promoted: result.keys },
          output:
            SessionToolSearch.formatResults({ tools: all, keys: result.keys }) +
            (result.keys.length > 0
              ? "\n\nThese tools are now loaded and callable for the rest of this session."
              : ""),
        } satisfies Tool.ExecuteResult<{ promoted: string[] }>
      }),
    }
  }),
)
