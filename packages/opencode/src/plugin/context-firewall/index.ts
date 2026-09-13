// Context Firewall — plugin hooks (plan §4).
//
// Threat: untrusted content (README, web page, GitHub issue, MCP result, RAG
// chunk) is read into the model's context and then the model emits a NEXT tool
// call that grants authority — a permission, a secret, DLP-off, a destructive
// op, a dependency install, a broker-policy change. The static permission
// ruleset cannot be altered by content, but the model can be talked into
// ACTING. The firewall removes authority from untrusted content itself.
//
// ENFORCEMENT IS PRIMARY AT THE MODEL SINK, detection is supplementary:
//   tool.execute.after                 (tag provenance: trust on output.metadata)
//   experimental.chat.messages.transform (neutralize directives in untrusted parts)
//
// The second hook is the last common model-facing sink — it runs before
// `toModelMessagesEffect` (prompt.ts) and before compaction (compaction.ts), on
// every step, in place. Fail-closed: if neutralization throws we replace the
// WHOLE message with a withheld placeholder rather than forward raw content.
//
// LIMITATION: this blocks untrusted content from granting AUTHORITY. The model
// may still REASON about the ideas in it (a README can legitimately explain how
// a feature works). Egress control and the permission ruleset remain separate.

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { NEUTRALIZED_PREFIX, isDirective, neutralize } from "./directives"
import { trustForTool, type Trust } from "./provenance"

/** Placeholder a whole message is replaced with when neutralization throws. */
export const WITHHELD = "[context-firewall] transform failed; message withheld to avoid forwarding untrusted authority."

/** Counts only — never content values. */
function audit(event: "tag" | "neutralize" | "withheld", payload: Record<string, unknown>): void {
  console.error(`[context-firewall] ${event}`, payload)
}

type PartLike = {
  type?: unknown
  tool?: unknown
  text?: unknown
  metadata?: Record<string, unknown>
  state?: {
    status?: unknown
    output?: unknown
    error?: unknown
    metadata?: Record<string, unknown>
  }
}

/** True if a part is explicitly tagged authoritative (on the part or its tool
 *  state). Such parts are NEVER neutralized — the tag is the operator's escape
 *  hatch for content that may legitimately grant authority. */
function isAuthoritative(part: PartLike): boolean {
  if (part.metadata?.["trust"] === "authoritative") return true
  return part.state?.metadata?.["trust"] === "authoritative"
}

/** True if a TOOL part carries untrusted content. Tool parts are classified by
 *  their `trust` tag first, else by tool name; a missing tag defaults to
 *  untrusted (fail-safe). */
function isUntrustedToolPart(part: PartLike): boolean {
  if (part.type !== "tool") return false
  const tagged = part.state?.metadata?.["trust"]
  if (tagged === "untrusted") return true
  if (tagged === "authoritative" || tagged === "normal") return false
  return typeof part.tool === "string" ? trustForTool(part.tool) === "untrusted" : true
}

/** Heuristic: a TEXT part in a message that ALSO contains an untrusted tool part
 *  is a model echo of tainted content, so it is a neutralization candidate when
 *  it itself matches a directive. Tradeoff: this can over-mark benign assistant
 *  prose that merely quotes a directive alongside untrusted tool output. We
 *  accept that because over-marking only withholds authority (fail-safe) while
 *  missing a real echo leaks it. Untagged text parts are candidates under this
 *  heuristic; authoritative-tagged parts are never touched. */
function isTaintedTextPart(part: PartLike, messageHasUntrustedTool: boolean): boolean {
  if (part.type !== "text") return false
  if (!messageHasUntrustedTool) return false
  if (isAuthoritative(part)) return false
  return typeof part.text === "string" && isDirective(part.text)
}

/** Neutralizes every string field of a part that can reach the model. Returns
 *  the count of strings changed. Never mutates trusted parts (caller guards). */
function neutralizePart(part: PartLike): number {
  let count = 0
  const rewrite = (value: unknown): unknown => {
    if (typeof value !== "string") return value
    const next = neutralize(value)
    if (next !== value) count++
    return next
  }
  if (typeof part.text === "string") part.text = rewrite(part.text)
  const state = part.state
  if (state) {
    if (typeof state.output === "string") state.output = rewrite(state.output)
    if (typeof state.error === "string") state.error = rewrite(state.error)
    const metadata = state.metadata
    if (metadata && typeof metadata["output"] === "string") metadata["output"] = rewrite(metadata["output"])
  }
  return count
}

/** Placeholder message preserving info identity, mirroring the broker pattern. */
function withheld(message: { info: unknown; parts: unknown[] }): typeof message {
  const info = message.info as { id?: unknown; role?: unknown } | undefined
  return {
    info: { id: info?.id, role: info?.role },
    parts: [{ type: "text", text: WITHHELD }],
  }
}

/** Builds the Context Firewall plugin Hooks. Stateless. */
export async function contextFirewallPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "tool.execute.after": async (hookInput, output) => {
      const trust: Trust = trustForTool(hookInput.tool)
      if (trust !== "untrusted") return
      // Tag provenance on the result metadata so the sink hook (and any cache
      // read) can classify the part without re-deriving the tool name. Fail-safe:
      // a tool we cannot classify is tagged untrusted.
      output.metadata = { ...(output.metadata ?? {}), trust }
      audit("tag", { tool: hookInput.tool, trust })
    },

    "experimental.chat.messages.transform": async (_hookInput, output) => {
      let neutralized = 0
      for (let index = 0; index < output.messages.length; index++) {
        const message = output.messages[index] as { info: unknown; parts: PartLike[] }
        try {
          const messageHasUntrustedTool = message.parts.some(isUntrustedToolPart)
          for (const part of message.parts) {
            const untrusted = isUntrustedToolPart(part)
            const tainted = isTaintedTextPart(part, messageHasUntrustedTool)
            if (!untrusted && !tainted) continue
            neutralized += neutralizePart(part)
          }
        } catch {
          // Neutralization may have rewritten some fields before a throwing
          // accessor aborted it — discard the WHOLE message rather than forward
          // any partially-processed sibling field.
          output.messages[index] = withheld(message) as typeof output.messages[number]
          audit("withheld", { index })
        }
      }
      if (neutralized > 0) audit("neutralize", { count: neutralized })
    },
  }
}

export default contextFirewallPlugin

// Internals exposed for focused tests / advanced wiring.
export { trustForSource, trustForTool, SOURCE_TRUST, type Trust } from "./provenance"
export { neutralize, isDirective, DIRECTIVE_PATTERNS, NEUTRALIZED_PREFIX } from "./directives"
