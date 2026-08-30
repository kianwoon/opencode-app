import { statSync } from "node:fs"
import type { Tool } from "@/tool/tool"

/**
 * Read-tool result cache.
 *
 * Coding agents re-run identical read/grep/glob calls within a session; results
 * are deterministic unless the underlying files change. This cache stores the
 * canonical tool's raw result (pre-attachment-wrap) keyed by tool + args (+ file
 * freshness for single-file reads) and is consulted only for allowlisted
 * read-only tools. Side-effectful tools never reach the cache.
 *
 * Boundaries:
 * - Hits skip `item.execute` only — plugin `tool.execute.before/after` triggers,
 *   attachment re-wrapping, and abort handling still run on every call.
 * - Hits bypass the `ctx.ask` permission check that `item.execute` performs
 *   internally. This is safe for read-only tools only: the first successful
 *   execution already recorded the user's grant for this session context, and
 *   the cached bytes cannot differ from what was approved. Documented trade-off,
 *   not an oversight.
 * - Bounded per session (insertion-order LRU) with a short TTL; disabled via
 *   OPENCODE_DISABLE_TOOL_CACHE=1.
 */

const TTL_MS = 60_000
const MAX_ENTRIES_PER_SESSION = 64
const MAX_SESSIONS = 1_000

/** Tools whose execution is a pure function of args + file contents. */
const CACHEABLE = new Set(["read", "glob", "grep"])

type Entry = { result: Tool.ExecuteResult; stored: number }

const sessions = new Map<string, Map<string, Entry>>()

function cacheFor(sessionID: string) {
  let cache = sessions.get(sessionID)
  if (!cache) {
    cache = new Map()
    sessions.set(sessionID, cache)
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
  }
  return cache
}

function cacheKey(toolID: string, args: Record<string, unknown>) {
  // read keys on file content freshness (mtime); glob/grep scan many files, so
  // they rely on the short TTL instead of per-file stat work.
  const filePath = typeof args.filePath === "string" ? args.filePath : undefined
  let freshness = "na"
  if (filePath) {
    try {
      const stat = statSync(filePath)
      freshness = `${stat.mtimeMs}:${stat.size}`
    } catch {
      // unreadable/vanished file: stable key; the TTL bounds staleness
    }
  }
  return `${toolID}\u0000${JSON.stringify(args)}\u0000${freshness}`
}

export function lookup(
  sessionID: string,
  toolID: string,
  args: Record<string, unknown>,
): Tool.ExecuteResult | undefined {
  if (process.env["OPENCODE_DISABLE_TOOL_CACHE"] === "1") return undefined
  if (!CACHEABLE.has(toolID)) return undefined
  const hit = cacheFor(sessionID).get(cacheKey(toolID, args))
  if (!hit) return undefined
  if (Date.now() - hit.stored > TTL_MS) {
    invalidate(sessionID, toolID, args)
    return undefined
  }
  return hit.result
}

export function store(
  sessionID: string,
  toolID: string,
  args: Record<string, unknown>,
  result: Tool.ExecuteResult,
) {
  if (process.env["OPENCODE_DISABLE_TOOL_CACHE"] === "1") return
  if (!CACHEABLE.has(toolID)) return
  const cache = cacheFor(sessionID)
  if (cache.size >= MAX_ENTRIES_PER_SESSION && !cache.has(cacheKey(toolID, args))) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(cacheKey(toolID, args), { result, stored: Date.now() })
}

export function invalidate(sessionID: string, toolID: string, args: Record<string, unknown>) {
  sessions.get(sessionID)?.delete(cacheKey(toolID, args))
}

export function clearSession(sessionID: string) {
  sessions.delete(sessionID)
}

/** Test hook: wipe all state. */
export function reset() {
  sessions.clear()
}

/** Test hook: expose stored entries for TTL aging without sleeping. */
export function inspect(): Map<string, Map<string, Entry>> {
  return sessions
}

export * as ToolResultCache from "./tool-result-cache"
