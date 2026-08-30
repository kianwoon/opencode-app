import { describe, expect, test } from "bun:test"
import { isComplete, propagateFailure, readySteps, validateDag } from "../../../src/session/workflow/dag"
import type { WorkflowStep } from "@opencode-ai/core/v1/session"

/**
 * Integration-style test for the workflow DAG scheduling, using the pure
 * scheduler against a simulated step runner so we can assert order,
 * parallelism, failure propagation, and the concurrency cap deterministically
 * (no LLM needed). Mirrors handleWorkflow's event-driven scheduler: a step
 * starts the moment capacity frees up, not on batch boundaries.
 */

type StepResult = { id: string; status: "completed" | "failed" | "skipped" }

/** Run a DAG of steps, recording outcomes and enforcing deps + the cap. */
async function runDag(
  steps: WorkflowStep[],
  runStep: (step: WorkflowStep) => Promise<"completed" | "failed">,
  options?: { concurrency?: number },
): Promise<{ results: StepResult[]; maxActive: number }> {
  const concurrency = options?.concurrency ?? Number.POSITIVE_INFINITY
  const dag = validateDag(steps)
  if ("_tag" in dag) throw new Error(`invalid dag: ${dag._tag}`)

  const completed = new Set<string>()
  const skipped = new Set<string>()
  const failed = new Set<string>()
  const settled = new Set<string>()
  const results: StepResult[] = []
  let active = 0
  let maxActive = 0

  const runOne = async (step: WorkflowStep) => {
    for (const dep of step.dependsOn) {
      if (!completed.has(dep) && !skipped.has(dep)) {
        throw new Error(`step ${step.id} started before dependency ${dep} settled`)
      }
    }
    active++
    maxActive = Math.max(maxActive, active)
    const status = await runStep(step)
    active--
    settled.add(step.id)
    if (status === "completed") completed.add(step.id)
    else {
      failed.add(step.id)
      for (const id of propagateFailure(dag, step.id)) skipped.add(id)
    }
  }

  const inflightIds = new Set<string>()
  const inflight = new Set<Promise<void>>()
  while (!isComplete(dag.steps, settled, skipped)) {
    const startable = readySteps(dag.steps, settled, skipped)
      .filter((step) => !inflightIds.has(step.id))
      .slice(0, concurrency - inflightIds.size)
    if (startable.length > 0) {
      for (const step of startable) {
        inflightIds.add(step.id)
        const p = runOne(step).then(() => {
          inflightIds.delete(step.id)
          inflight.delete(p)
        })
        inflight.add(p)
      }
      continue
    }
    if (inflight.size === 0) throw new Error("deadlock")
    await Promise.race(inflight)
  }

  await Promise.all(inflight)

  // Deterministic summary in declaration order (mirrors handleWorkflow).
  for (const step of steps) {
    if (completed.has(step.id)) results.push({ id: step.id, status: "completed" })
    else if (failed.has(step.id)) results.push({ id: step.id, status: "failed" })
    else results.push({ id: step.id, status: "skipped" })
  }
  return { results, maxActive }
}

const steps: WorkflowStep[] = [
  { id: "build", prompt: "build", description: "build", agent: "build", dependsOn: [] },
  { id: "test", prompt: "test", description: "test", agent: "build", dependsOn: ["build"] },
  { id: "lint", prompt: "lint", description: "lint", agent: "build", dependsOn: ["build"] },
  { id: "publish", prompt: "publish", description: "publish", agent: "build", dependsOn: ["test", "lint"] },
]

describe("workflow scheduling", () => {
  test("runs dependencies first and independent steps in parallel", async () => {
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const { results } = await runDag(steps, async (step) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, step.id === "lint" ? 1 : 10))
      active--
      order.push(step.id)
      return "completed"
    })
    // build first; test+lint may finish in any order; publish after both.
    expect(order[0]).toBe("build")
    expect(order.slice(1, 3).sort()).toEqual(["lint", "test"])
    expect(order[3]).toBe("publish")
    expect(maxActive).toBeGreaterThan(1)
    expect(results).toEqual([
      { id: "build", status: "completed" },
      { id: "test", status: "completed" },
      { id: "lint", status: "completed" },
      { id: "publish", status: "completed" },
    ])
  })

  test("starts an unrelated dependent as soon as its own deps settle (no batch barrier)", async () => {
    // Diamond: slow (60ms) and fast (1ms) both depend on build; tail depends
    // only on fast. A batch-barrier scheduler delays tail until slow ends;
    // the event-driven scheduler starts tail after ~1ms.
    const diamond: WorkflowStep[] = [
      { id: "build", prompt: "", description: "", agent: "build", dependsOn: [] },
      { id: "slow", prompt: "", description: "", agent: "build", dependsOn: ["build"] },
      { id: "fast", prompt: "", description: "", agent: "build", dependsOn: ["build"] },
      { id: "tail", prompt: "", description: "", agent: "build", dependsOn: ["fast"] },
    ]
    const timings = new Map<string, number>()
    const start = Date.now()
    await runDag(diamond, async (step) => {
      await new Promise((r) => setTimeout(r, step.id === "slow" ? 60 : 1))
      timings.set(step.id, Date.now() - start)
      return "completed"
    })
    // tail must start (and finish) well before slow finishes.
    expect(timings.get("tail")!).toBeLessThan(timings.get("slow")!)
  })

  test("caps concurrent steps at the configured limit", async () => {
    const fanout: WorkflowStep[] = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      prompt: "",
      description: "",
      agent: "build",
      dependsOn: [],
    }))
    let active = 0
    let maxActive = 0
    const { results } = await runDag(
      fanout,
      async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return "completed"
      },
      { concurrency: 3 },
    )
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(results.every((r) => r.status === "completed")).toBe(true)
    expect(results).toHaveLength(8)
  })

  test("marks transitive dependents skipped when a step fails", async () => {
    const { results } = await runDag(steps, async (step) => {
      if (step.id === "build") return "failed"
      return "completed"
    })
    expect(results).toEqual([
      { id: "build", status: "failed" },
      { id: "test", status: "skipped" },
      { id: "lint", status: "skipped" },
      { id: "publish", status: "skipped" },
    ])
  })

  test("failure of one branch does not skip the sibling branch", async () => {
    const { results } = await runDag(steps, async (step) => {
      if (step.id === "test") return "failed"
      return "completed"
    })
    expect(results).toEqual([
      { id: "build", status: "completed" },
      { id: "test", status: "failed" },
      { id: "lint", status: "completed" },
      { id: "publish", status: "skipped" },
    ])
  })

  test("validates a cyclic workflow as an error", () => {
    const result = validateDag([
      { id: "a", prompt: "", description: "", agent: "", dependsOn: ["b"] },
      { id: "b", prompt: "", description: "", agent: "", dependsOn: ["a"] },
    ] as WorkflowStep[])
    expect("_tag" in result && result._tag === "cycle").toBe(true)
  })
})
