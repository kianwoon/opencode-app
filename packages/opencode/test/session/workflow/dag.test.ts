import { describe, expect, test } from "bun:test"
import {
  isComplete,
  propagateFailure,
  readySteps,
  validateDag,
  type WorkflowStepInput,
} from "../../../src/session/workflow/dag"

const release: WorkflowStepInput[] = [
  { id: "build", dependsOn: [] },
  { id: "test", dependsOn: ["build"] },
  { id: "lint", dependsOn: ["build"] },
  { id: "publish", dependsOn: ["test", "lint"] },
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

  test("readySteps returns only steps whose deps are satisfied", () => {
    const dag = validateDag(release)
    if (!("steps" in dag)) throw new Error("expected valid dag")
    // Nothing done → only build is ready.
    expect(readySteps(dag.steps, new Set(), new Set()).map((s) => s.id)).toEqual(["build"])
    // build done → test and lint ready (parallel).
    expect(readySteps(dag.steps, new Set(["build"]), new Set()).map((s) => s.id).sort()).toEqual(["lint", "test"])
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
