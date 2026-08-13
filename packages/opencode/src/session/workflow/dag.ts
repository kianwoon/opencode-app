/**
 * Pure DAG (directed acyclic graph) scheduling logic for workflow steps.
 *
 * No Effect, no session, no I/O — just the graph algorithms a workflow needs:
 * validation, topological ordering, readiness computation for parallel
 * execution, and failure propagation. Keeping this pure makes it trivially
 * unit-testable and lets the loop dispatcher stay thin.
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

/** Validated graph: every step id is known and referenced ids exist. */
export interface ValidatedDag<S extends StepLike = WorkflowStepInput> {
  readonly steps: readonly S[]
  /** step id → its dependents (reverse edges), for failure propagation. */
  readonly dependents: ReadonlyMap<string, readonly string[]>
}

export type DagError =
  | { readonly _tag: "cycle"; readonly cycle: readonly string[] }
  | { readonly _tag: "missing-step"; readonly stepId: string; readonly missing: string }

/**
 * Validate a step list forms a DAG: all `dependsOn` ids must refer to existing
 * steps and there must be no cycle. Returns the validated graph with reverse
 * edges (dependents) precomputed, or a {@link DagError}.
 */
export function validateDag<S extends StepLike>(steps: readonly S[]): ValidatedDag<S> | DagError {
  const byId = new Map(steps.map((s) => [s.id, s]))

  // Every referenced id must exist.
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) {
        return { _tag: "missing-step", stepId: step.id, missing: dep }
      }
    }
  }

  // Cycle detection via iterative DFS with white/grey/black coloring.
  const color = new Map<string, "grey" | "black">()
  const stack: string[] = []
  const visit = (id: string): readonly string[] | undefined => {
    const c = color.get(id)
    if (c === "black") return undefined
    if (c === "grey") {
      // Found a cycle: extract from the stack back to this id.
      const from = stack.lastIndexOf(id)
      return [...stack.slice(from), id]
    }
    color.set(id, "grey")
    stack.push(id)
    const step = byId.get(id)!
    for (const dep of step.dependsOn) {
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    stack.pop()
    color.set(id, "black")
    return undefined
  }

  for (const step of steps) {
    const cycle = visit(step.id)
    if (cycle) return { _tag: "cycle", cycle }
  }

  const dependents = new Map<string, string[]>(steps.map((s) => [s.id, []]))
  for (const step of steps) {
    for (const dep of step.dependsOn) dependents.get(dep)!.push(step.id)
  }
  return { steps, dependents }
}

/** Topologically ordered step ids (dependencies first). */
export function topoSort<S extends StepLike>(dag: ValidatedDag<S>): readonly string[] {
  const result: string[] = []
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    const step = dag.steps.find((s) => s.id === id)!
    for (const dep of step.dependsOn) visit(dep)
    result.push(id)
  }
  for (const step of dag.steps) visit(step.id)
  return result
}

/**
 * Steps whose dependencies are all satisfied (in `completed`).
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
export function propagateFailure(
  dag: ValidatedDag,
  failed: string,
): ReadonlySet<string> {
  const skipped = new Set<string>()
  const queue = [...(dag.dependents.get(failed) ?? [])]
  while (queue.length > 0) {
    const id = queue.shift()!
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
