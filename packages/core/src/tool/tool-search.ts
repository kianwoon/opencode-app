export * as ToolSearchTool from "./tool-search.js"

import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Mcp } from "../mcp/index.js"

export const TOOL_SEARCH_TOOL = "find_tools"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Words to match against tool names, server names, and descriptions. Use an exact `server_tool` key to promote a specific tool.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

const DESCRIPTION = `Search and load deferred MCP tools. When a session has many MCP tools, their full definitions are not loaded into context; only the catalog in this description is. Call this tool with a query matching a tool's name or purpose to load its full definition and make it callable for the session. Loaded tools may be unloaded again if context pressure rises; search again to reload them.`

const keyOf = (tool: Mcp.Tool) => `${tool.server}_${tool.name}`

/**
 * Deferred-MCP tool search. Registered only when deferral is active (see
 * session/tools.ts); the dynamic catalog is appended to its description at
 * registry time so the model can decide what to promote without any tool
 * ever being hardcoded.
 */
export const Plugin = {
  id: "opencode.tool.find_tools",
  effect: Effect.fn("ToolSearchTool.Plugin")(function* (ctx: PluginContext) {
    const mcp = yield* Mcp.Service

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: TOOL_SEARCH_TOOL,
        options: { codemode: false },
        description: DESCRIPTION,
        input: Parameters,
        execute: Effect.fn("ToolSearch.execute")(function* (params: Params) {
          const all = yield* mcp.tools()
          const needle = params.query.trim().toLowerCase()
          const keys = all
            .filter((tool) => {
              const key = keyOf(tool).toLowerCase()
              if (key === needle) return true
              return (
                tool.name.toLowerCase().includes(needle) ||
                tool.server.toLowerCase().includes(needle) ||
                (tool.description ?? "").toLowerCase().includes(needle)
              )
            })
            .map(keyOf)
          const lines = keys.length === 0 ? ["No matching deferred tools."] : keys.map((key) => `- ${key}`)
          return {
            content: [lines.join("\n")].join(""),
            metadata: { promoted: keys },
          }
        }),
      }),
    )
  }),
}
