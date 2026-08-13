import { describe, expect, test } from "bun:test"
import {
  isComplete,
  propagateFailure,
  readySteps,
  validateDag,
} from "../../../src/session/workflow/dag"
import type { WorkflowStep } from "@opencode-ai/core/v1/session"

/**
 * Integration-style test for the workflow DAG scheduling, using the pure
 * scheduler against a simulated step runner so we can assert order,
 * parallelism, and failure propagation deterministically (no LLM needed).
 */

type StepResult = { id: string; status: "completed" | "failed" | "skipped" }

/** Run a DAG of steps, recording completion order and enforcing deps. */
async function runDag(
  steps: WorkflowStep[],
  runStep: (step: WorkflowStep) => Promise<StepResult>,
): Promise<{ order: string[]; results: StepResult[] }> {
  const dag = validateDag(steps)
  if ("_tag" in dag) throw new Error(`invalid dag: ${dag._tag}`)

    const completed = new Set<string>()
    const skipped = new Set<string>()
    const failedSet = new Set<string>()
    const results: StepResult[] = []
    const order: string[] = []
    const running = new Set<string>()

    const runOne = async (step: WorkflowStep) => {
      // Enforce that dependencies completed before this starts.
      for (const dep of step.dependsOn) {
        if (!completed.has(dep) && !skipped.has(dep)) {
          throw new Error(`step ${step.id} started before dependency ${dep}`)
        }
      }
      running.add(step.id)
      const r = await runStep(step)
      running.delete(step.id)
      if (r.status === "completed") {
        completed.add(step.id)
        order.push(step.id)
      } else {
        failedSet.add(step.id)
        const newly = propagateFailure(dag, step.id)
        for (const id of newly) skipped.add(id)
      }
      results.push(r)
      for (const id of skipped) results.push({ id, status: "skipped" })
    }

    // Simple level-by-level scheduling (parallel within a level).
    while (!isComplete(dag.steps, completed, skipped)) {
      // Treat failed steps as done too, so the loop can terminate.
      const done = new Set([...completed, ...failedSet])
      if (steps.every((s) => done.has(s.id) || skipped.has(s.id))) break
      const ready = readySteps(dag.steps, done, skipped)
      if (ready.length === 0) throw new Error("deadlock")
      await Promise.all(ready.map(runOne))
    }

  return { order, results }
}

const steps: WorkflowStep[] = [
  { id: "build", prompt: "build", description: "build", agent: "build", dependsOn: [] },
  { id: "test", prompt: "test", description: "test", agent: "build", dependsOn: ["build"] },
  { id: "lint", prompt: "lint", description: "lint", agent: "build", dependsOn: ["build"] },
  { id: "publish", prompt: "publish", description: "publish", agent: "build", dependsOn: ["test", "lint"] },
]

describe("workflow scheduling", () => {
  test("runs dependencies first and independent steps in parallel", async () => {
    let active = 0
    let maxActive = 0
    const { order, results } = await runDag(steps, async (step) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, step.id === "lint" ? 1 : 10))
      active--
      return { id: step.id, status: "completed" as const }
    })
    // build first, test+lint parallel, publish last.
    expect(order[0]).toBe("build")
    expect(order.slice(1, 3).sort()).toEqual(["lint", "test"])
    expect(order[3]).toBe("publish")
    // Parallelism happened (test+lint overlapped).
    expect(maxActive).toBeGreaterThan(1)
    expect(results.every((r) => r.status === "completed")).toBe(true)
  })

  test("marks transitive dependents skipped when a step fails", async () => {
    const { results } = await runDag(steps, async (step) => {
      if (step.id === "build") return { id: step.id, status: "failed" as const }
      return { id: step.id, status: "completed" as const }
    })
    const failed = results.filter((r) => r.status === "failed").map((r) => r.id)
    const skippedIds = results.filter((r) => r.status === "skipped").map((r) => r.id)
    expect(failed).toEqual(["build"])
    expect(skippedIds.sort()).toEqual(["lint", "publish", "test"])
  })

  test("validates a cyclic workflow as an error", () => {
    const result = validateDag([
      { id: "a", prompt: "", description: "", agent: "", dependsOn: ["b"] },
      { id: "b", prompt: "", description: "", agent: "", dependsOn: ["a"] },
    ] as WorkflowStep[])
    expect("_tag" in result && result._tag === "cycle").toBe(true)
  })
})
