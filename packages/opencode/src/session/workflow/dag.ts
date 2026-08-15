/**
 * Pure DAG (directed acyclic graph) scheduling logic for workflow steps.
 *
 * No Effect, no session, no I/O — just the graph algorithms a workflow needs:
 * validation, readiness computation for parallel execution, and failure
 * propagation. Keeping this pure makes it trivially unit-testable and lets the
 * loop dispatcher stay thin.
 *
 * @module @opencode-ai/opencode/session/workflow/dag
 */

/** One workflow step, as the scheduler sees it. */
export interface WorkflowStepInput {
  readonly id: string
  /** Step ids that must complete before this one may run. */
  readonly dependsOn: readonly string[]
}

/** A step type that carries at least the graph fields. */
type StepLike = { readonly id: string; readonly dependsOn: readonly string[] }

/** Validated graph: every step id is known, unique, and referenced ids exist. */
export interface ValidatedDag<S extends StepLike = WorkflowStepInput> {
  readonly steps: readonly S[]
  /** step id → its dependents (reverse edges), for failure propagation. */
  readonly dependents: ReadonlyMap<string, readonly string[]>
}

export type DagError =
  | { readonly _tag: "duplicate-step"; readonly stepId: string }
  | { readonly _tag: "missing-step"; readonly stepId: string; readonly missing: string }
  | { readonly _tag: "cycle"; readonly cycle: readonly string[] }

/** Hard cap on steps per workflow; larger fan-outs need explicit config. */
export const MAX_WORKFLOW_STEPS = 64

export type WorkflowAdmissionError =
  | DagError
  | { readonly _tag: "empty-steps" }
  | { readonly _tag: "too-many-steps"; readonly count: number; readonly max: number }

/**
 * Full admission check shared by every entry point (the model-facing
 * `workflow` tool and the loop dispatcher's direct-part path): graph shape
 * plus the step-count bound. Both callers must enforce the same rules so a
 * direct API `PromptInput` cannot bypass the tool's cap.
 */
export function validateWorkflow<S extends StepLike>(
  steps: readonly S[],
): ValidatedDag<S> | WorkflowAdmissionError {
  if (steps.length === 0) return { _tag: "empty-steps" }
  if (steps.length > MAX_WORKFLOW_STEPS)
    return { _tag: "too-many-steps", count: steps.length, max: MAX_WORKFLOW_STEPS }
  return validateDag(steps)
}

/** Format an admission error for the model/session error surface. */
export function workflowErrorMessage(title: string, error: WorkflowAdmissionError): string {
  switch (error._tag) {
    case "cycle":
      return `Workflow "${title}" has a dependency cycle: ${error.cycle.join(" -> ")}`
    case "duplicate-step":
      return `Workflow "${title}" has duplicate step id "${error.stepId}"`
    case "missing-step":
      return `Workflow "${title}" step "${error.stepId}" references unknown step "${error.missing}"`
    case "empty-steps":
      return `Workflow "${title}" has no steps`
    case "too-many-steps":
      return `Workflow "${title}" has ${error.count} steps; the maximum is ${error.max}`
  }
}

/**
 * Validate a step list forms a DAG: ids must be unique, all `dependsOn` ids
 * must refer to existing steps, and there must be no cycle. Returns the
 * validated graph with reverse edges (dependents) precomputed, or a
 * {@link DagError}.
 */
export function validateDag<S extends StepLike>(steps: readonly S[]): ValidatedDag<S> | DagError {
  const byId = new Map<string, S>()
  for (const step of steps) {
    if (byId.has(step.id)) return { _tag: "duplicate-step", stepId: step.id }
    byId.set(step.id, step)
  }

  // Every referenced id must exist.
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) {
        return { _tag: "missing-step", stepId: step.id, missing: dep }
      }
    }
  }

  // Cycle detection via iterative DFS with white/grey/black coloring. The
  // explicit stack (not recursion) keeps a long dependency chain from
  // overflowing the call stack. Each frame is [stepId, next dep index]; the
  // stack always holds the current DFS path for cycle extraction.
  const color = new Map<string, "grey" | "black">()
  for (const root of steps) {
    if (color.has(root.id)) continue
    color.set(root.id, "grey")
    const stack: Array<[string, number]> = [[root.id, 0]]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const [id, index] = frame
      const deps = byId.get(id)!.dependsOn
      if (index < deps.length) {
        frame[1] = index + 1
        const dep = deps[index]!
        const c = color.get(dep)
        if (c === "grey") {
          // Found a cycle: the path from `dep` (bottom-most grey frame) to
          // the current frame, closed back to `dep`.
          const from = stack.findIndex(([frameId]) => frameId === dep)
          return { _tag: "cycle", cycle: [...stack.slice(from).map(([id]) => id), dep] }
        }
        if (c === "black") continue
        color.set(dep, "grey")
        stack.push([dep, 0])
        continue
      }
      stack.pop()
      color.set(id, "black")
    }
  }

  const dependents = new Map<string, string[]>(steps.map((s) => [s.id, []]))
  for (const step of steps) {
    for (const dep of step.dependsOn) dependents.get(dep)!.push(step.id)
  }
  return { steps, dependents }
}

/**
 * Steps whose dependencies are all satisfied (in `completed` or `skipped`).
 * The `skipped` check is currently defensive: the scheduler only populates
 * `skipped` transitively via failure propagation, so a skipped dependency
 * always implies this step is skipped too. Keep the clause so readiness
 * stays correct if skipped-ever-becomes an independently-reachable state.
 * Returns an empty array when there is work left but nothing is ready
 * (a deadlock — the caller should treat it as an error).
 */
export function readySteps<S extends StepLike>(
  steps: readonly S[],
  completed: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
): readonly S[] {
  return steps.filter(
    (s) =>
      !completed.has(s.id) &&
      !skipped.has(s.id) &&
      s.dependsOn.every((dep) => completed.has(dep) || skipped.has(dep)),
  )
}

/**
 * When a step fails, mark its transitive dependents as skipped. Returns the
 * full set of newly skipped ids (excluding the failed step itself, which the
 * caller records separately).
 */
export function propagateFailure(dag: ValidatedDag, failed: string): ReadonlySet<string> {
  const skipped = new Set<string>()
  const queue = [...(dag.dependents.get(failed) ?? [])]
  // Index cursor instead of shift(): shift is O(n) per pop, O(n²) over a run.
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    if (skipped.has(id)) continue
    skipped.add(id)
    queue.push(...(dag.dependents.get(id) ?? []))
  }
  return skipped
}

/** True when every step is completed or skipped (the workflow is done). */
export function isComplete(
  steps: readonly StepLike[],
  completed: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
): boolean {
  return steps.every((s) => completed.has(s.id) || skipped.has(s.id))
}
