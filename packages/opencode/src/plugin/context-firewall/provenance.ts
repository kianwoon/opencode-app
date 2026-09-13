// Context Firewall — provenance model (plan §4).
//
// Authority is a property of WHERE content came from, not of what it says.
// Untrusted content (a README, a fetched web page, a GitHub issue, an MCP tool
// result, a RAG chunk) may inform reasoning but can NEVER grant authority:
// permissions, secrets, DLP state, destructive ops, dependency approval or
// broker policy. This module is PURE: it only classifies, never mutates.

/** Trust level of a piece of content. `authoritative` may grant authority;
 *  `untrusted` may never. `normal` is project content that informs but does
 *  not grant authority — treated as untrusted at the enforcement sink. */
export type Trust = "authoritative" | "normal" | "untrusted"

/** Source label -> trust. Unknown labels default to `untrusted` (fail-safe). */
export const SOURCE_TRUST: Readonly<Record<string, Trust>> = {
  user: "authoritative",
  project_policy: "authoritative",
  project_file: "normal",
  readme: "normal",
  web: "untrusted",
  github: "untrusted",
  mcp: "untrusted",
  rag: "untrusted",
}

/** Classifies a content SOURCE label. Missing/unknown => untrusted. */
export function trustForSource(source: string): Trust {
  return SOURCE_TRUST[source] ?? "untrusted"
}

// Tools whose output is attacker-influenced content read into context. `read`
// (a project README, a vendored file), search/glob, network fetches and every
// MCP tool are all untrusted: the model may reason about them, but their bytes
// must never be read as an instruction that grants authority.
const UNTRUSTED_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "list",
  "webfetch",
  "websearch",
  "web_search",
  "fetch",
])

/** Classifies a TOOL name for `tool.execute.after` tagging. Any tool we do not
 *  explicitly recognise defaults to `untrusted` (fail-safe): an unknown tool's
 *  output is never treated as authoritative. */
export function trustForTool(tool: string): Trust {
  if (tool.startsWith("mcp")) return "untrusted"
  if (UNTRUSTED_TOOLS.has(tool)) return "untrusted"
  return "untrusted"
}
