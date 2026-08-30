import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { Effect } from "effect"

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const page = await list(cursor)
    result.push(...items(page))
    if (page.nextCursor === undefined) return result
    if (cursors.has(page.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${page.nextCursor}`)
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

export function defs(client: Client, timeout?: number) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT).pipe(Effect.catch(() => Effect.void))
}

export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number): Tool {
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, options) => {
      const result = await client.callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal: options.abortSignal,
          timeout,
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      )
      if (result.isError)
        throw new Error(
          result.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      if (result.content.length > 0 || result.structuredContent === undefined || result.structuredContent === null)
        return result
      return {
        ...result,
        content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
      }
    },
  })
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Promise<T[]>,
  label: string,
  key?: (item: T) => string,
) {
  return Effect.tryPromise({
    try: () => list(client),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
      const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
      return Object.fromEntries(
        items.map((item) => [
          key ? resourceClient + ":" + key(item) : sanitizedClient + ":" + sanitize(item.name),
          { ...item, client: clientName },
        ]),
      )
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

/** Tool and server instructions are truncated at this size before entering context (matches Claude Code). */
export const DESCRIPTION_MAX_BYTES = 2_048

function truncateUtf8(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= maxBytes) return value
  let cut = maxBytes
  // Never split a multi-byte UTF-8 sequence: back off to a code-point boundary.
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1
  return bytes.subarray(0, cut).toString("utf8").trimEnd() + "…"
}

/** Compact description safe to load into context; critical details live at the start. */
export function compactDescription(value: string | undefined) {
  return truncateUtf8(value ?? "", DESCRIPTION_MAX_BYTES)
}

/** Approximate context cost of a tool definition (description + JSON schema), in bytes. */
export function definitionBytes(mcpTool: MCPToolDef) {
  return Buffer.byteLength(mcpTool.description ?? "", "utf8") + Buffer.byteLength(JSON.stringify(mcpTool.inputSchema), "utf8")
}

/** One catalog entry: enough to decide relevance without loading the full schema. */
export interface ToolIndexEntry {
  /** Namespaced key used by session tools (`server_tool`). */
  key: string
  server: string
  tool: string
  description: string
}

export interface ServerIndex {
  server: string
  instructions?: string
  tools: ToolIndexEntry[]
}

/**
 * Build a compact catalog index: names + truncated descriptions per server,
 * plus server instructions. Never includes input schemas — that is the whole
 * point; full definitions stay deferred until tool_search promotes them.
 */
export function index(defs: Record<string, { name: string; description?: string }>, serverInstructions: Record<string, string | undefined>): ServerIndex[] {
  const byServer = new Map<string, ToolIndexEntry[]>()
  for (const [key, def] of Object.entries(defs)) {
    const server = key.slice(0, key.indexOf("_") > 0 ? key.indexOf("_") : undefined) || key
    const entry: ToolIndexEntry = {
      key,
      server,
      tool: def.name,
      description: compactDescription(def.description),
    }
    byServer.set(server, [...(byServer.get(server) ?? []), entry])
  }
  return [...byServer.entries()].toSorted(([a], [b]) => a.localeCompare(b)).map(([server, tools]) => ({
    server,
    instructions: serverInstructions[server],
    tools,
  }))
}

/** Render the index as the tool_search tool description: compact, scannable, schema-free. */
export function describeIndex(index: ServerIndex[]): string {
  return index
    .map((server) => {
      const lines = server.tools.map((tool) => `  - ${tool.tool}: ${tool.description}`)
      const head = server.instructions ? [`## ${server.server}`, server.instructions] : [`## ${server.server}`]
      return [...head, ...lines].join("\n")
    })
    .join("\n\n")
}

export function prompts(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return paginate(
    (cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.prompts,
  )
}

export function resources(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resources,
  )
}

export function resourceTemplates(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resourceTemplates,
  )
}

function listTools(client: Client, timeout: number) {
  return Effect.tryPromise({
    try: () =>
      paginate(
        async (cursor) => {
          const params = cursor === undefined ? undefined : { cursor }
          try {
            return await client.listTools(params, { timeout })
          } catch (error) {
            if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
            return client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, { timeout })
          }
        },
        (result) => result.tools,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

export * as McpCatalog from "./catalog"
