export * as ToolSearch from "./tool-search"

import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"

/**
 * Client-side MCP tool-search deferral (Claude Code "tool search" parity):
 * when MCP tool definitions would flood the context window, keep only a compact
 * catalog (names + truncated descriptions + server instructions) in context and
 * promote full definitions on demand through the `tool_search` tool.
 *
 * Promotion state is per session: once the model surfaces a tool via
 * `tool_search`, it stays in the tools array for the rest of that session.
 * `alwaysLoad` servers bypass deferral entirely. All inputs are explicit —
 * this module holds no service dependencies.
 */

/** Default threshold: defer when definitions exceed this fraction of the context window (CC's `auto` = 10%). */
export const DEFAULT_THRESHOLD = 0.1

/** Per-session set of MCP tool keys promoted out of the deferred catalog. */
const promoted = new Map<string, Set<string>>()

/** Bound on tracked sessions; promotion state is cheap but sessions can be long-lived. */
const MAX_TRACKED_SESSIONS = 1_000

function promotedFor(sessionID: string): Set<string> {
  const existing = promoted.get(sessionID)
  if (existing) return existing
  if (promoted.size >= MAX_TRACKED_SESSIONS) {
    // Map iteration order is insertion order: evict the oldest session.
    const oldest = promoted.keys().next().value
    if (oldest !== undefined) promoted.delete(oldest)
  }
  const fresh = new Set<string>()
  promoted.set(sessionID, fresh)
  return fresh
}

/** Drop promotion state (session ended, or budget fell back under threshold). */
export function clear(sessionID: string) {
  promoted.delete(sessionID)
}

/** Server names whose config sets `alwaysLoad: true`. */
export function alwaysLoadServers(mcpConfig: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  for (const [name, entry] of Object.entries(mcpConfig)) {
    if (
      entry &&
      typeof entry === "object" &&
      "alwaysLoad" in entry &&
      (entry as { alwaysLoad?: unknown }).alwaysLoad === true
    )
      names.add(name)
  }
  return names
}

/** The namespaced key's server segment (`github_create_pr` -> `github`). */
export function serverOf(key: string) {
  const i = key.indexOf("_")
  return i > 0 ? key.slice(0, i) : key
}

export interface Deferral {
  /** MCP tools that load fully into context this turn (alwaysLoad servers + promoted). */
  inline: Record<string, MCP.McpTool>
  /** Deferred tools, keyed as they appear in the catalog. */
  deferred: Record<string, MCP.McpTool>
  /** Rendered compact catalog for the tool_search description (empty when nothing is deferred). */
  catalog: string
}

/**
 * Split visible MCP tools into inline vs deferred for this session/turn.
 * Deferral engages only when total definition bytes cross the threshold —
 * small setups keep today's behavior exactly. The threshold is a fraction of
 * the context window (0 defers immediately, 1 never defers); values outside
 * 0-1 fall back to the default.
 */
export function plan(input: {
  sessionID: string
  tools: Record<string, MCP.McpTool>
  contextLimit: number
  threshold?: number
  mcpConfig: Record<string, unknown>
}): Deferral {
  const alwaysLoad = alwaysLoadServers(input.mcpConfig)
  const raw = input.threshold
  const threshold = raw !== undefined && raw >= 0 && raw <= 1 ? raw : DEFAULT_THRESHOLD
  const budget = input.contextLimit > 0 ? input.contextLimit * threshold : Number.POSITIVE_INFINITY

  let total = 0
  for (const entry of Object.values(input.tools)) total += McpCatalog.definitionBytes(entry.def)

  // Under budget: everything inline, exactly like the pre-deferral behavior.
  if (total <= budget) {
    clear(input.sessionID)
    return { inline: input.tools, deferred: {}, catalog: "" }
  }

  const promotedSet = promotedFor(input.sessionID)
  const inline: Record<string, MCP.McpTool> = {}
  const deferred: Record<string, MCP.McpTool> = {}
  for (const [key, entry] of Object.entries(input.tools)) {
    if (alwaysLoad.has(serverOf(key)) || promotedSet.has(key)) inline[key] = entry
    else deferred[key] = entry
  }

  const serverInstructions: Record<string, string | undefined> = {}
  for (const server of new Set(Object.keys(deferred).map(serverOf))) serverInstructions[server] = undefined
  const indexDefs: Record<string, { name: string; description?: string }> = Object.fromEntries(
    Object.entries(deferred).map(([key, entry]) => [key, entry.def]),
  )
  return { inline, deferred, catalog: McpCatalog.describeIndex(McpCatalog.index(indexDefs, serverInstructions)) }
}

/**
 * Match a tool_search query against the deferred catalog and promote hits.
 * Exact key match wins; otherwise case-insensitive substring match over
 * key, native tool name, and description. Already-inline tools are skipped.
 */
export function search(input: {
  sessionID: string
  query: string
  tools: Record<string, MCP.McpTool>
  mcpConfig: Record<string, unknown>
}): { keys: string[] } {
  const alwaysLoad = alwaysLoadServers(input.mcpConfig)
  const needle = input.query.trim().toLowerCase()
  if (!needle) return { keys: [] }

  const promotedSet = promotedFor(input.sessionID)
  const exact: string[] = []
  const fuzzy: string[] = []
  for (const [key, entry] of Object.entries(input.tools)) {
    if (alwaysLoad.has(serverOf(key)) || promotedSet.has(key)) continue
    if (key.toLowerCase() === needle) exact.push(key)
    else if (`${key} ${entry.def.name} ${entry.def.description ?? ""}`.toLowerCase().includes(needle)) fuzzy.push(key)
  }
  const keys = exact.length > 0 ? exact : fuzzy
  for (const key of keys) promotedSet.add(key)
  return { keys }
}

/** Result body for a tool_search call: promoted tools' full definitions as JSON. */
export function formatResults(input: { tools: Record<string, MCP.McpTool>; keys: string[] }) {
  if (input.keys.length === 0)
    return "No matching MCP tools found. Try a shorter query or a server/tool name from the catalog."
  return input.keys
    .map((key) => {
      const def = input.tools[key]!.def
      return [`### ${key}`, def.description ?? "", JSON.stringify(def.inputSchema)].join("\n")
    })
    .join("\n\n")
}

/** Test hook: reset all per-session promotion state. */
export function reset() {
  promoted.clear()
}
