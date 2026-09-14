/**
 * Task-aware context governor — pure, dependency-free core.
 *
 * Design invariants (agreed):
 *   - Explicit acts only: Tier 1 (destructive/role-changing) requires an explicit
 *     marker. Tier 2 guesses only NUDGE (a stale-context hint line), never evict.
 *   - Everything reversible: state lives in plain TaskRecord values; nothing is
 *     deleted, only archived.
 *   - Cache-safe: task switches never mutate the provider prefix in place —
 *     they only trigger an epoch rollover (compaction with preserve-facts).
 *     All functions are deterministic: same input → same output.
 */

// ---------------------------------------------------------------------------
// TaskRecord
// ---------------------------------------------------------------------------

export type TaskStatus = "active" | "running" | "stale" | "archived" | "done"

export interface TaskRecord {
  id: string
  goal: string
  decisions: string[]
  files_changed: string[]
  known_failures: string[]
  status: TaskStatus
}

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------

export type Tier = "tier1-explicit" | "tier2-suggestive" | "same-task"

/** Tier 1: explicit role-changing acts. ONLY these may take destructive action. */
const TIER1_PATTERNS: RegExp[] = [
  /^\s*\/task-new\b/,
  /^\s*\/task-done\b/,
  /\blet'?s switch to\b/i,
  /\bswitch(?:ing)? (?:to|over to) (?:a |the )?(?:new|different) task\b/i,
  /\bnew task\b/i,
  /\btask (?:is )?(?:complete|complete[d]?|done|finished)\b/i,
]

/** Tier 2: suggestive — guesses nudge only. */
const TIER2_PATTERNS: RegExp[] = [
  /\bby the way\b/i,
  /\bforget (?:that|about (?:that|it))\b/i,
  /\bdifferent thing\b/i,
  /\bnever mind\b/i,
]

/** Branch / worktree change signal (Tier 1: explicit environment act). */
const BRANCH_PATTERNS: RegExp[] = [
  /\b(?:checkout|switch)(?:ing)? to (?:branch|worktree)\b/i,
  /\bworktree (?:add|switch)\b/i,
  /\bgit checkout\b/i,
]

const matchesAny = (text: string, patterns: RegExp[]): boolean => patterns.some((p) => p.test(text))

/**
 * Classify an incoming user message against the active task.
 * Default is "same-task" — ambiguous messages NEVER take destructive action.
 */
export const detectTier = (msg: string, activeTask?: TaskRecord): Tier => {
  const text = msg ?? ""
  if (text.trim().length === 0) return "same-task"
  if (matchesAny(text, TIER1_PATTERNS) || matchesAny(text, BRANCH_PATTERNS)) return "tier1-explicit"
  if (matchesAny(text, TIER2_PATTERNS)) return "tier2-suggestive"
  return "same-task"
}

// ---------------------------------------------------------------------------
// Scoring bias (relevance ordering)
// ---------------------------------------------------------------------------

export interface PinSpec {
  taskId: string
  pinned: boolean
}

/**
 * Score an item's task affinity. Deterministic:
 *   - belongs to the active task → 1.0 (full weight)
 *   - explicitly pinned (kept regardless of task) → 1.0 keep
 *   - other tasks → 0.2 discount (nudge-toward-prune, never auto-evict alone)
 */
export const scoreActive = (taskId: string | undefined, activeId: string | undefined, pin?: PinSpec): number => {
  if (pin?.pinned) return 1.0
  if (taskId === undefined || activeId === undefined) return 0.5
  return taskId === activeId ? 1.0 : 0.2
}

// ---------------------------------------------------------------------------
// File-drift detection (Tier 2, suggest-only — never evicts)
// ---------------------------------------------------------------------------

/** Compare key: full path, or top-2 path segments for workspace-relative drift. */
const pathKey = (p: string): string => {
  const parts = p.split("/").filter(Boolean)
  return parts.length > 2 ? parts.slice(0, 2).join("/") : p
}

/**
 * Detect file drift: when the recent file window (deterministic, no LLM) shows
 * ≤ overlapThreshold path-key overlap with the active task's files, suggest a
 * nudge. PURE — returns a hint string only; never evicts, never switches.
 */
export const driftNudge = (
  activeFiles: string[],
  recentFiles: string[],
  opts?: { minRecent?: number; overlapThreshold?: number },
): { drifted: boolean; overlap: number; hint: string } => {
  const minRecent = opts?.minRecent ?? 3
  const overlapThreshold = opts?.overlapThreshold ?? 0.1
  const recent = recentFiles.filter(Boolean)
  if (recent.length < minRecent) return { drifted: false, overlap: 1, hint: "" }
  const activeKeys = new Set(activeFiles.filter(Boolean).map(pathKey))
  const recentKeys = [...new Set(recent.map(pathKey))]
  const overlapCount = recentKeys.filter((k) => activeKeys.has(k)).length
  const overlap = recentKeys.length > 0 ? overlapCount / recentKeys.length : 1
  const drifted = overlap <= overlapThreshold
  const hint = drifted
    ? `You've touched ${recentKeys.length - overlapCount} files with zero ${activeFiles.length > 0 ? "active-task" : "task"} overlap for ${recent.length} turns — collapse the task? [y/n]`
    : ""
  return { drifted, overlap, hint }
}

// ---------------------------------------------------------------------------
// Tail boundary extension
// ---------------------------------------------------------------------------

/**
 * findTailStart extension: treat a task_id change as a tail boundary. The tail
 * never starts BEFORE the newest boundary, so content from the previous task
 * epoch is always prune-eligible and the current task's epoch stays protected.
 * Boundary anchors are message ids; a message whose metadata task_id differs
 * from the previous message's starts a new epoch.
 *
 * Deterministic and position-based → cache-safe (boundary moves only when new
 * tagged messages arrive, never per step).
 */
export const tailStartWithTaskBoundary = (
  baseTailStart: number,
  messages: { info?: { id?: string }; meta?: { task_id?: string } }[],
  activeId?: string,
): number => {
  let boundary = messages.length
  for (let i = 0; i < messages.length; i++) {
    const prev = i > 0 ? messages[i - 1]?.meta?.task_id : undefined
    const cur = messages[i]?.meta?.task_id
    if (cur !== undefined && prev !== undefined && cur !== prev) boundary = i
    if (activeId !== undefined && cur !== undefined && cur !== activeId) {
      // First message of the CURRENT task epoch: everything after it is protected.
      // Find the LAST such transition into activeId instead — handled below.
    }
  }
  // Prefer the newest transition into the active task, if any.
  let activeBoundary = -1
  for (let i = 0; i < messages.length; i++) {
    const cur = messages[i]?.meta?.task_id
    const prev = i > 0 ? messages[i - 1]?.meta?.task_id : undefined
    if (activeId !== undefined && cur === activeId && prev !== activeId) activeBoundary = i
  }
  const taskBoundary = activeBoundary >= 0 ? activeBoundary : boundary
  return Math.min(Math.max(baseTailStart, taskBoundary), messages.length)
}

// ---------------------------------------------------------------------------
// Worker context packaging (subagents)
// ---------------------------------------------------------------------------

export interface WorkerPkg {
  brief: string
  files: string[]
  pins: PinSpec[]
  outputContract: string
}

/** Working-set character cap ≈ 15k tokens (deterministic truncation, head+tail). */
export const WORKING_SET_CAP_CHARS = 15_000 * 4
const OUTPUT_CONTRACT =
  "Return a single result object: { task_id, summary, decisions[], files_changed[], known_failures[] }. " +
  "No narration outside the object."

/**
 * Build a self-contained brief for a worker/subagent. The stable core is the
 * SAME content the main agent's L0 system layer carries — identical bytes →
 * shared provider prefix when the worker's system layer matches.
 * Pins whose task_id differs from the active task are filtered out.
 */
export const buildWorkerContext = (
  stableCore: string,
  activeTask: TaskRecord,
  workingSet: string[],
  pins: PinSpec[] = [],
): WorkerPkg => {
  const taskPins = pins.filter((p) => p.taskId === activeTask.id)
  let budget = Math.max(0, WORKING_SET_CAP_CHARS - stableCore.length)
  const files: string[] = []
  for (const entry of workingSet) {
    if (budget <= 0) break
    if (entry.length <= budget) {
      files.push(entry)
      budget -= entry.length
    } else {
      // Deterministic head+tail truncation (same input → same output).
      // Reserve ~40 chars for the separator so total ≤ budget.
      const side = Math.max(0, Math.floor((budget - 40) / 2))
      const sep = `…[${entry.length - side * 2} chars]…`
      files.push(`${entry.slice(0, side)}\n${sep}\n${entry.slice(-side)}`)
      budget = 0
    }
  }
  const decisions = activeTask.decisions.length > 0 ? `Decisions: ${activeTask.decisions.join("; ")}` : ""
  const failures = activeTask.known_failures.length > 0 ? `Known failures (do not retry): ${activeTask.known_failures.join("; ")}` : ""
  const brief = [activeTask.goal, decisions, failures].filter(Boolean).join("\n")
  return { brief, files, pins: taskPins, outputContract: OUTPUT_CONTRACT }
}

// ---------------------------------------------------------------------------
// Ingest promotion gating
// ---------------------------------------------------------------------------

/**
 * Should a finished worker's result be promoted into the active task?
 * Promote ONLY when the worker's task_id matches the active task AND the
 * active task is not stale (a pending switch invalidates late returns).
 * Otherwise archive (reversible, nothing lost).
 */
export const shouldPromote = (
  resultTaskId: string | undefined,
  activeId: string | undefined,
  isStale: boolean,
): boolean => resultTaskId !== undefined && resultTaskId === activeId && !isStale
