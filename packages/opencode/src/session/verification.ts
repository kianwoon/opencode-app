/**
 * Task verification gate — decides whether a finished task warrants an
 * automatic reviewer pass before the session goes idle.
 *
 * Pure and synchronous: inspects the last task's user prompt and the
 * assistant's tool parts for risk signals (sensitive domains, destructive
 * operations, breadth of mutation). No LLM call, no I/O — the loop calls this
 * at the task tail and spawns the reviewer subagent when the verdict says so.
 *
 * Risky-file detection uses basename/path substring matching, mirroring the
 * effort router's keyword discipline: cheap, deterministic, explainable.
 *
 * @module @opencode-ai/opencode/session/verification
 */

export interface VerificationInput {
  /** The task's initiating user prompt text. */
  readonly prompt: string
  /** Tool parts from the whole task (assistant messages since the user message). */
  readonly tools: readonly {
    readonly tool: string
    readonly state: { readonly status: string }
  }[]
}

export type VerificationVerdict = {
  /** True when the task should end with an automatic reviewer pass. */
  review: boolean
  /** Why the verdict fired; surfaced in the reviewer prompt for focus. */
  reason: string
}

/** Domains where mistakes are expensive — a mutation here deserves review. */
const RISKY_PATH_HINTS = [
  "auth",
  "credential",
  "secret",
  "password",
  "permission",
  "migrat",
  "schema",
  "payment",
  "billing",
  "security",
  "encrypt",
  "token",
  "session",
]

/** Prompts that signal risk even when the touched files look benign. */
const RISKY_PROMPT_HINTS = [
  "delete",
  "drop ",
  "remove all",
  "purge",
  "production",
  "deploy",
  "release",
  "rotate",
  "revoke",
]

/** Prompt breadth signals — multi-area work benefits from a second pass. */
const BREADTH_PROMPT_HINTS = ["refactor", "migrate", "redesign", "rewrite", "across", "codebase"]

/** Mutation tools whose outputs count as edits (edit/write/patch share `edit`). */
const MUTATION_TOOLS = new Set(["edit", "write", "patch", "apply_patch"])

/**
 * Verdict for the automatic reviewer gate. Completed mutations only count —
 * failed/aborted edits do not make a task risky by themselves.
 */
export function verificationGate(input: VerificationInput): VerificationVerdict {
  const lowerPrompt = input.prompt.toLowerCase()
  const mutated = input.tools.some((t) => MUTATION_TOOLS.has(t.tool) && t.state.status === "completed")
  if (!mutated) return { review: false, reason: "no files were modified" }

  const lowerPaths = input.tools
    .flatMap((t) => {
      const file = (t.state as { input?: { filePath?: string } }).input?.filePath
      return typeof file === "string" ? [file.toLowerCase()] : []
    })
    .join(" ")

  const riskyPath = RISKY_PATH_HINTS.find((hint) => lowerPaths.includes(hint))
  if (riskyPath) return { review: true, reason: `modified a risk-sensitive path (matched "${riskyPath}")` }

  const riskyPrompt = RISKY_PROMPT_HINTS.find((hint) => lowerPrompt.includes(hint))
  if (riskyPrompt)
    return { review: true, reason: `task involves a destructive operation (matched "${riskyPrompt.trim()}")` }

  const breadthHits = BREADTH_PROMPT_HINTS.filter((hint) => lowerPrompt.includes(hint)).length
  const mutatedCount = input.tools.filter((t) => MUTATION_TOOLS.has(t.tool)).length
  if (breadthHits >= 2 || (breadthHits >= 1 && mutatedCount >= 6))
    return { review: true, reason: "broad refactor touching many files" }

  return { review: false, reason: "routine mutation" }
}
