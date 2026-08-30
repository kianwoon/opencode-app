import { describe, expect, test } from "bun:test"
import {
  MAX_WORKFLOW_STEPS,
  isComplete,
  propagateFailure,
  readySteps,
  validateDag,
  validateWorkflow,
  workflowErrorMessage,
  type WorkflowStepInput,
} from "../../../src/session/workflow/dag"

const release: WorkflowStepInput[] = [
  { id: "build", agent: "build", dependsOn: [] },
  { id: "test", agent: "build", dependsOn: ["build"] },
  { id: "lint", agent: "build", dependsOn: ["build"] },
  { id: "publish", agent: "build", dependsOn: ["test", "lint"] },
]

describe("workflow dag", () => {
  test("validates a well-formed DAG", () => {
    const dag = validateDag(release)
    expect("steps" in dag).toBe(true)
    if ("steps" in dag) {
      expect(dag.dependents.get("build")).toEqual(["test", "lint"])
      expect(dag.dependents.get("test")).toEqual(["publish"])
    }
  })

  test("detects missing step references", () => {
    const result = validateDag([{ id: "a", dependsOn: ["nope"] }])
    expect(result).toEqual({ _tag: "missing-step", stepId: "a", missing: "nope" })
  })

  test("detects duplicate step ids", () => {
    const result = validateDag([
      { id: "a", dependsOn: [] },
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
    ])
    expect(result).toEqual({ _tag: "duplicate-step", stepId: "a" })
  })

  test("detects cycles", () => {
    const result = validateDag([
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ])
    if ("steps" in result) throw new Error("expected a cycle error")
    if (result._tag !== "cycle") throw new Error("expected a cycle error")
    expect(result.cycle.length).toBeGreaterThan(1)
  })

  test("detects self-dependencies as cycles", () => {
    const result = validateDag([{ id: "x", dependsOn: ["x"] }])
    expect("_tag" in result && result._tag === "cycle").toBe(true)
  })

  test("cycle detection survives a deep dependency chain without recursion overflow", () => {
    // 50k-step linear chain would blow the call stack if cycle detection
    // recursed; the iterative DFS must handle it (and find no cycle).
    const chain: WorkflowStepInput[] = Array.from({ length: 50_000 }, (_, i) => ({
      id: `s${i}`,
      agent: "build",
      dependsOn: i === 0 ? [] : [`s${i - 1}`],
    }))
    const result = validateDag(chain)
    expect("steps" in result).toBe(true)

    // The same chain closed into a ring (s0 depends on the tail) is one
    // giant cycle and must be reported, not crash.
    const cyclic: WorkflowStepInput[] = chain.map((step, i) =>
      i === 0 ? { id: step.id, agent: step.agent, dependsOn: ["s49999"] } : step,
    )
    const looped = validateDag(cyclic)
    expect("_tag" in looped && looped._tag === "cycle").toBe(true)
  })

  test("cycle detection reports longer cycles anywhere in the graph", () => {
    // a -> b -> c -> b: cycle [b, c, b]
    const result = validateDag([
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["c"] },
      { id: "c", dependsOn: ["b"] },
    ])
    expect("_tag" in result && result._tag === "cycle").toBe(true)
    if ("_tag" in result && result._tag === "cycle") {
      expect(result.cycle[0]).toBe(result.cycle[result.cycle.length - 1])
      expect(result.cycle.length).toBeGreaterThan(1)
    }
  })

  test("readySteps returns only steps whose deps are satisfied", () => {
    const dag = validateDag(release)
    if (!("steps" in dag)) throw new Error("expected valid dag")
    // Nothing done → only build is ready.
    expect(readySteps(dag.steps, new Set(), new Set()).map((s) => s.id)).toEqual(["build"])
    // build done → test and lint ready (parallel).
    expect(
      readySteps(dag.steps, new Set(["build"]), new Set())
        .map((s) => s.id)
        .sort(),
    ).toEqual(["lint", "test"])
    // build + test + lint done → publish ready.
    expect(readySteps(dag.steps, new Set(["build", "test", "lint"]), new Set()).map((s) => s.id)).toEqual(["publish"])
  })

  test("readySteps respects skipped steps as satisfied", () => {
    const dag = validateDag(release)
    if (!("steps" in dag)) throw new Error("expected valid dag")
    // build skipped → test/lint skipped via propagation → publish's deps are
    // all satisfied, so publish is ready.
    const skipped = new Set(["build", "test", "lint"])
    expect(readySteps(dag.steps, new Set(), skipped).map((s) => s.id)).toEqual(["publish"])
  })

  test("propagateFailure marks transitive dependents skipped", () => {
    const dag = validateDag(release)
    if (!("steps" in dag)) throw new Error("expected valid dag")
    // build fails → test, lint, publish all skipped.
    expect([...propagateFailure(dag, "build")].sort()).toEqual(["lint", "publish", "test"])
    // test fails → only publish skipped (lint is not a dependent of test).
    expect([...propagateFailure(dag, "test")]).toEqual(["publish"])
  })

  test("isComplete is true only when everything is done or skipped", () => {
    expect(isComplete(release, new Set(["build", "test", "lint", "publish"]), new Set())).toBe(true)
    expect(isComplete(release, new Set(["build"]), new Set())).toBe(false)
    expect(isComplete(release, new Set(), new Set(["build", "test", "lint", "publish"]))).toBe(true)
  })
})

describe("workflow admission (validateWorkflow)", () => {
  test("accepts a well-formed graph within the step cap", () => {
    const result = validateWorkflow(release)
    expect("steps" in result).toBe(true)
  })

  test("rejects empty step lists", () => {
    const result = validateWorkflow([])
    expect("_tag" in result && result._tag === "empty-steps").toBe(true)
    expect(workflowErrorMessage("t", { _tag: "empty-steps" })).toContain("has no steps")
  })

  test("rejects graphs over the step cap with the count in the message", () => {
    const fanout: WorkflowStepInput[] = Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, (_, i) => ({
      id: `s${i}`,
      agent: "build",
      dependsOn: [],
    }))
    const result = validateWorkflow(fanout)
    expect("_tag" in result && result._tag === "too-many-steps").toBe(true)
    if ("_tag" in result && result._tag === "too-many-steps") {
      expect(result.count).toBe(MAX_WORKFLOW_STEPS + 1)
      expect(result.max).toBe(MAX_WORKFLOW_STEPS)
      expect(workflowErrorMessage("t", result)).toBe(
        `Workflow "t" has ${MAX_WORKFLOW_STEPS + 1} steps; the maximum is ${MAX_WORKFLOW_STEPS}`,
      )
    }
  })

  test("admits exactly at the cap", () => {
    const fanout: WorkflowStepInput[] = Array.from({ length: MAX_WORKFLOW_STEPS }, (_, i) => ({
      id: `s${i}`,
      agent: "build",
      dependsOn: [],
    }))
    expect("steps" in validateWorkflow(fanout)).toBe(true)
  })

  test("surfaces graph-shape errors through the shared message formatter", () => {
    const missing = validateWorkflow([{ id: "a", agent: "build", dependsOn: ["nope"] }])
    expect(workflowErrorMessage("t", missing as { _tag: "missing-step"; stepId: string; missing: string })).toContain(
      'references unknown step "nope"',
    )
  })

  test("rejects steps referencing an unknown agent when agent names are provided", () => {
    const result = validateWorkflow(
      [
        { id: "a", agent: "build", dependsOn: [] },
        { id: "b", agent: "biuld", dependsOn: ["a"] },
      ],
      new Set(["build", "general"]),
    )
    expect("_tag" in result && result._tag === "unknown-agent").toBe(true)
    if ("_tag" in result && result._tag === "unknown-agent") {
      expect(result.stepId).toBe("b")
      expect(result.agent).toBe("biuld")
      expect(workflowErrorMessage("t", result)).toBe('Workflow "t" step "b" references unknown agent "biuld"')
    }
  })

  test("admits all agents present in the provided set", () => {
    const result = validateWorkflow(
      [
        { id: "a", agent: "build", dependsOn: [] },
        { id: "b", agent: "general", dependsOn: ["a"] },
      ],
      new Set(["build", "general"]),
    )
    expect("steps" in result).toBe(true)
  })

  test("agent validation is skipped when no agent set is provided", () => {
    const result = validateWorkflow([{ id: "a", agent: "whoever", dependsOn: [] }])
    expect("steps" in result).toBe(true)
  })
})
