import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { CONTROLS_MAX, LABEL_MAX, buildControllerQuestions, buildState, foldController, type NavMap } from "@/jev/controller"
import {
  Parameters,
  UiRunTool,
  advanceMap,
  buildCandidates,
  decideStep,
  decodeObservation,
  isDestructive,
  isGoalMet,
  needsForegroundDelivery,
  normalizeExpect,
  screenSignature,
} from "@/tool/ui-run"
import { MessageID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

// The test env configures no MCP servers, so the real MCP.Service has no
// cua-driver tools and the tool must degrade to the not-connected notice.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([MCP.node, Truncate.node, Agent.node, InstanceStore.node]),
    [
      [
        Config.node,
        TestConfig.layer({
          directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
        }),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    ],
  ),
)

const toolContext = (): Tool.Context => ({
  sessionID: SessionID.create(),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const window = { pid: 4242, window_id: 7 }

// Shapes mirror a live cua-driver get_window_state capture: element_index is NOT
// the array position, and AXStaticText/AXImage carry no actions.
const button = (i: number, label: string, extra: Record<string, unknown> = {}) => ({
  element_index: 100 - i,
  element_token: `s00000011:${i}`,
  role: "AXButton",
  label,
  ...extra,
})

const text = (i: number, label: string) => ({
  element_index: i,
  element_token: `s00000011:${i}`,
  role: "AXStaticText",
  label,
})

describe("ui_run parameters", () => {
  test("decodes a minimal valid run", () => {
    const decoded = Schema.decodeUnknownOption(Parameters)({
      goal: "open the settings pane",
      window,
      steps: [{ intent: "click Settings" }],
    })

    expect(decoded._tag).toBe("Some")
    if (decoded._tag !== "Some") return
    expect(decoded.value.steps?.length).toBe(1)
    expect(decoded.value.window.window_id).toBe(7)
    expect(decoded.value.expect).toBeUndefined()
  })

  test("decodes a goal-driven run with value + maxSteps and no steps", () => {
    const decoded = Schema.decodeUnknownOption(Parameters)({ goal: "g", window, value: "jev", maxSteps: 40 })

    expect(decoded._tag).toBe("Some")
    if (decoded._tag !== "Some") return
    expect(decoded.value.steps).toBeUndefined()
    expect(decoded.value.value).toBe("jev")
    expect(decoded.value.maxSteps).toBe(40)
  })

  test("decodes a fill step carrying a value", () => {
    const decoded = Schema.decodeUnknownOption(Parameters)({
      goal: "search",
      window,
      steps: [{ intent: "focus the search field" }, { intent: "type the query", value: "jev" }],
    })

    expect(decoded._tag).toBe("Some")
    if (decoded._tag !== "Some") return
    expect(decoded.value.steps?.[1].value).toBe("jev")
  })

  test("passes verify predicates through unchanged", () => {
    const predicates = [{ kind: "visible", label: "Preferences" }]
    const decoded = Schema.decodeUnknownOption(Parameters)({ goal: "g", window, steps: [{ intent: "i" }], expect: predicates })

    expect(decoded._tag).toBe("Some")
    if (decoded._tag !== "Some") return
    expect(decoded.value.expect).toEqual(predicates)
  })

  test("rejects a run with no window", () => {
    expect(Schema.decodeUnknownOption(Parameters)({ goal: "g", steps: [{ intent: "i" }] })._tag).toBe("None")
  })

  test("rejects a step missing its intent", () => {
    expect(Schema.decodeUnknownOption(Parameters)({ goal: "g", window, steps: [{ value: "x" }] })._tag).toBe("None")
  })
})

describe("decodeObservation", () => {
  test("decodes a probe-verified structuredContent payload", () => {
    const decoded = decodeObservation({
      snapshot_id: "s00000011",
      elements: [button(1, "Settings"), text(2, "Preferences")],
    })

    expect(decoded?.snapshot_id).toBe("s00000011")
    expect(decoded?.elements.length).toBe(2)
    expect(decoded?.elements[0].element_token).toBe("s00000011:1")
  })

  test("an undecodable payload is null rather than guessed from text", () => {
    expect(decodeObservation(undefined)).toBeNull()
    expect(decodeObservation("window title: Settings")).toBeNull()
    expect(decodeObservation({ elements: [] })).toBeNull()
    expect(decodeObservation({ snapshot_id: "s1", elements: [{ role: "AXButton" }] })?.elements[0].role).toBe("AXButton")
  })

  // hardcode-guard:allow test mirrors the documented live cua-driver wire shapes (markdown default + elements)
  test("decodes the live payload in both wire formats (markdown default and elements)", () => {
    // Driver DEFAULT (tree_format omitted => "markdown"): a `tree_markdown` string
    // and NO top-level `elements` — the exact body that decoded to null at step 0.
    const markdown = decodeObservation({
      snapshot_id: "s00000011",
      tree_markdown: "Window\n  AXButton Settings",
    })

    expect(markdown).not.toBeNull()
    expect(markdown?.snapshot_id).toBe("s00000011")
    expect(markdown?.elements).toEqual([])

    // The format ui_run now requests (tree_format:"elements"): top-level `elements`.
    const elements = decodeObservation({
      snapshot_id: "s00000011",
      elements: [button(1, "Settings"), text(2, "Preferences")],
    })

    expect(elements?.elements.length).toBe(2)
    expect(buildCandidates(elements?.elements ?? []).labels).toEqual(["c1 AXButton Settings"])
  })
})

describe("buildCandidates", () => {
  test("drops non-interactive and disabled elements, keeping order", () => {
    const { labels } = buildCandidates([
      text(1, "Preferences"),
      button(2, "Settings"),
      { element_index: 3, element_token: "s00000011:3", role: "AXImage", label: "avatar" },
      button(4, "Disabled", { enabled: false }),
      button(5, "Cancel"),
    ])

    expect(labels).toEqual(["c1 AXButton Settings", "c2 AXButton Cancel"])
  })

  test("skips elements with no role or no token", () => {
    const { labels } = buildCandidates([
      { element_index: 1, role: "AXButton", label: "tokenless" },
      { element_index: 2, element_token: "s00000011:2", label: "roleless" },
      button(3, "Keep"),
    ])

    expect(labels).toEqual(["c1 AXButton Keep"])
  })

  test("caps at CONTROLS_MAX and marks the truncation", () => {
    const many = Array.from({ length: CONTROLS_MAX + 5 }, (_, i) => button(i + 1, `label-${i}`))
    const capped = buildCandidates(many.slice(0, CONTROLS_MAX))
    const oversize = buildCandidates(many)

    expect(capped.labels.length).toBe(CONTROLS_MAX)
    expect(capped.truncated).toBeUndefined()
    expect(oversize.labels.length).toBe(CONTROLS_MAX)
    expect(oversize.truncated).toContain("truncated")
    expect(oversize.truncated).toContain(String(CONTROLS_MAX + 5))
  })

  test("clips each label to LABEL_MAX and round-trips it to its element", () => {
    const { labels, byLabel } = buildCandidates([button(1, "x".repeat(300))])

    expect(labels[0].length).toBe(LABEL_MAX)
    expect(byLabel.get(labels[0])?.element_token).toBe("s00000011:1")
  })
})

describe("needsForegroundDelivery", () => {
  // Verbatim driver refusal from the 2026-10-03 flight: one pid owning 15 sibling
  // windows, so process-scoped key events cannot be proven to reach the target.
  const refusal =
    `Background input refused (same_pid_keyboard_ambiguity): pid 1316 owns 15 other eligible top-level window(s); ` +
    `process-scoped key events cannot be proven to reach window 2332 and could mutate a sibling window. ` +
    `Use an exact element action, the page tool for browser content, or delivery_mode:"foreground"`

  test("true for the verbatim multi-window keyboard refusal", () => {
    expect(needsForegroundDelivery(refusal)).toBe(true)
  })

  test("false for a missing-tool failure", () => {
    expect(needsForegroundDelivery("cua-driver_click: tool not found on cua-driver server")).toBe(false)
  })

  test("false for an ordinary AX failure", () => {
    expect(needsForegroundDelivery("AXError: cannot perform action on AXStaticText")).toBe(false)
  })

  test("false for the empty string", () => {
    expect(needsForegroundDelivery("")).toBe(false)
  })
})

describe("normalizeExpect", () => {
  test('coerces a stringly-typed exists while leaving the string field untouched', () => {
    expect(normalizeExpect([{ element: { exists: "true", label_contains: "Form submitted" } }])).toEqual([
      { element: { exists: true, label_contains: "Form submitted" } },
    ])
  })

  test('coerces "false" and passes real booleans through unchanged', () => {
    expect(normalizeExpect([{ window: { exists: "false", enabled: true, selected: false } }])).toEqual([
      { window: { exists: false, enabled: true, selected: false } },
    ])
  })

  test("returns an empty array for empty input", () => {
    expect(normalizeExpect([])).toEqual([])
  })

  test("passes unknown keys and non-object values through unchanged", () => {
    const predicates = [{ role: "button", count: 3, label: "OK", list: [1, 2], enabled: "TRUE" }]
    expect(normalizeExpect(predicates)).toEqual(predicates)
  })
})

// Shapes mirror live decisions captures (choice + per-label probabilities).
const ans = (choice: string, probabilities: Record<string, number>) => ({ type: "choice", choice, probabilities })

const index = (elements: Parameters<typeof buildCandidates>[0]) => {
  const candidates = buildCandidates(elements)
  return { labels: candidates.labels, byLabel: candidates.byLabel }
}

const accepted = (answers: Record<string, unknown>) => foldController({ answers }, 0.7)

describe("decideStep", () => {
  const base = {
    candidates: index([button(1, "Save"), button(2, "Settings")]),
    goalMet: false,
    evidence: false,
    step: 0,
    maxSteps: 30,
    ambiguous: 0,
    maxAmbiguous: 3,
  }

  test("a below-gate decision falls to a SAFE action, it does not abort", () => {
    const outcome = accepted({ action: ans("click", { click: 0.55, wait: 0.45 }) })
    const v = decideStep({ ...base, outcome })
    expect(v.kind).toBe("safe")
    if (v.kind !== "safe") throw new Error("expected safe")
    expect(v.reason).toBe("below-gate")
  })

  test("an unmeasured decision falls to a SAFE action", () => {
    const v = decideStep({ ...base, outcome: foldController({}, 0.7) })
    expect(v.kind).toBe("safe")
  })

  test("advisory goal_met true with NO evidence CONTINUES rather than stopping", () => {
    const outcome = accepted({ action: ans("done", { done: 0.99 }) })
    const v = decideStep({ ...base, outcome, goalMet: true })
    expect(v.kind).toBe("safe")
    if (v.kind !== "safe") throw new Error("expected safe")
    expect(v.reason).toBe("goal-met-advisory-no-evidence")
  })

  test("observed evidence stops as verified, over every advisory signal", () => {
    const outcome = accepted({ action: ans("click", { click: 0.9 }) })
    const v = decideStep({ ...base, outcome, evidence: true, goalMet: true })
    expect(v.kind).toBe("stop")
    if (v.kind !== "stop") throw new Error("expected stop")
    expect(v.reason).toBe("evidence-satisfied")
  })

  test("a target validated against the FRESH candidates becomes an act", () => {
    const outcome = accepted({
      action: ans("click", { click: 0.9, wait: 0.1 }),
      target: ans("0:c2 AXButton Settings", { "0:c2 AXButton Settings": 0.95, none: 0.05 }),
    })
    const v = decideStep({ ...base, outcome })
    expect(v.kind).toBe("act")
    if (v.kind !== "act") throw new Error("expected act")
    expect(v.element.element_token).toBe("s00000011:2")
  })

  test("a target absent from THIS iteration's candidates falls safe (never a stale map)", () => {
    const outcome = accepted({
      action: ans("click", { click: 0.9 }),
      target: ans("0:c9 AXButton Gone", { "0:c9 AXButton Gone": 0.95 }),
    })
    const v = decideStep({ ...base, outcome, candidates: index([button(1, "Save")]) })
    expect(v.kind).toBe("safe")
    if (v.kind !== "safe") throw new Error("expected safe")
    expect(v.reason).toBe("target-not-in-fresh-candidates")
  })

  test("a destructive target stops for consent BEFORE acting", () => {
    const outcome = accepted({
      action: ans("click", { click: 0.9 }),
      target: ans("0:c1 AXButton Save", { "0:c1 AXButton Save": 0.95 }),
    })
    const v = decideStep({ ...base, outcome, candidates: index([button(1, "Save")]) })
    expect(v.kind).toBe("checkpoint")
    if (v.kind !== "checkpoint") throw new Error("expected checkpoint")
    expect(v.target).toContain("Save")
  })

  test("budget exhaustion is a hard stop", () => {
    const v = decideStep({ ...base, outcome: foldController({}, 0.7), step: 30 })
    expect(v.kind).toBe("stop")
    if (v.kind !== "stop") throw new Error("expected stop")
    expect(v.reason).toBe("budget-exhausted")
  })

  test("the ambiguity bound stops a run that never acts", () => {
    const v = decideStep({ ...base, outcome: foldController({}, 0.7), ambiguous: 3 })
    expect(v.kind).toBe("stop")
    if (v.kind !== "stop") throw new Error("expected stop")
    expect(v.reason).toBe("ambiguous-limit")
  })

  test("a type decision without text falls safe instead of typing nothing", () => {
    const outcome = accepted({
      action: ans("type", { type: 0.9 }),
      target: ans("0:c1 AXButton Field", { "0:c1 AXButton Field": 0.95 }),
    })
    const v = decideStep({ ...base, outcome, candidates: index([button(1, "Field")]) })
    expect(v.kind).toBe("safe")
    if (v.kind !== "safe") throw new Error("expected safe")
    expect(v.reason).toBe("type-without-text")
  })
})

describe("isDestructive", () => {
  test("flags the consent verbs and passes ordinary controls", () => {
    expect(isDestructive("c1 AXButton Save")).toBe(true)
    expect(isDestructive("Submit")).toBe(true)
    expect(isDestructive("Delete account")).toBe(true)
    expect(isDestructive("Confirm")).toBe(true)
    expect(isDestructive("c2 AXButton Settings")).toBe(false)
  })
})

// hardcode-guard:allow fixture node ids, labels and per-step answers are the enumerable input under test
describe("navigation map chaining", () => {
  const GOAL = "buy the widget"

  // A screen is defined by its role+label structure ONLY. Every observation gets
  // a FRESH snapshot id (and therefore fresh element tokens/indices) — exactly
  // what the driver does live — so the node identity must not depend on them.
  const screenAt = (snapshot: string, shape: ReadonlyArray<readonly [string, string]>) =>
    shape.map(([role, label], i) => ({
      element_index: i + 1,
      element_token: `${snapshot}:${i + 1}`,
      role,
      label,
    }))

  const observe = (snapshot: string, shape: ReadonlyArray<readonly [string, string]>) => {
    const decoded = decodeObservation({ snapshot_id: snapshot, elements: screenAt(snapshot, shape) })
    if (!decoded) throw new Error("fixture observation failed to decode")
    return decoded
  }

  const ansOf = (target: string) => ({
    action: ans("click", { click: 0.9, wait: 0.1 }),
    target: ans(target, { [target]: 0.95, none: 0.05 }),
  })

  // The chain the loop runs: observe -> enumerate frontier -> build map -> ask
  // jev over the frontier -> decide -> act -> repeat. `advanceMap` is the only
  // stateful piece; the decider is the real foldController over jev-shaped answers.
  const decideAt = (
    step: number,
    evidence: boolean,
    elements: Parameters<typeof buildCandidates>[0],
    answers: Record<string, unknown>,
  ) => {
    const candidates = buildCandidates(elements)
    const outcome = foldController({ answers }, 0.7)
    const verdict = decideStep({
      outcome,
      candidates: { labels: candidates.labels, byLabel: candidates.byLabel },
      goalMet: isGoalMet(outcome),
      evidence,
      step,
      maxSteps: 8,
      ambiguous: 0,
      maxAmbiguous: 3,
    })
    return { candidates, verdict }
  }

  // hardcode-guard:allow fixture shapes/labels are the enumerable input under test
  const shapes: Record<string, ReadonlyArray<readonly [string, string]>> = {
    home: [["AXButton", "Products"]],
    products: [["AXButton", "Widget"], ["AXButton", "Gift"]],
    widget: [["AXButton", "Proceed"], ["AXButton", "Back"]],
    gift: [["AXButton", "Add to cart"]],
    cart: [["AXButton", "Confirm order"]],
  }
  const next: Record<string, Record<string, string>> = {
    home: { Products: "products" },
    products: { Widget: "widget", Gift: "gift" },
    widget: { Proceed: "cart" },
    gift: { "Add to cart": "cart" },
    cart: {},
  }
  const nodeId = (id: string) => screenSignature(screenAt("any", shapes[id]))

  test("screenSignature is stable across changing snapshot ids, tokens and indices", () => {
    const a = screenAt("snap-a", shapes.products)
    const b = screenAt("snap-b", shapes.products)
    expect(a[0].element_token).not.toBe(b[0].element_token)
    expect(screenSignature(a)).toBe(screenSignature(b))
    expect(screenSignature(a)).toBe(nodeId("products"))
  })

  test("the same screen observed twice with fresh snapshot ids is ONE visit", () => {
    const a = observe("snap-a", shapes.products)
    const b = observe("snap-b", shapes.products)
    expect(b.snapshot_id).not.toBe(a.snapshot_id)
    const first = advanceMap(GOAL, undefined, a.elements, buildCandidates(a.elements).labels)
    const second = advanceMap(GOAL, first, b.elements, buildCandidates(b.elements).labels)
    // Different observation, same screen: path records VISITS, not observations.
    expect(second.current).toBe(first.current)
    expect(second.path).toEqual([first.current])
  })

  test("signature distinguishes a modal dialog from the screen behind it", () => {
    // Same shared control ("Cancel"), different body: an unseen screen the
    // structure still separates from the base window.
    const base = screenAt("s1", [["AXButton", "Cancel"], ["AXStaticText", "Untitled document"]])
    const dialog = screenAt("s2", [["AXButton", "Cancel"], ["AXStaticText", "Save changes before quitting?"]])
    expect(screenSignature(base)).not.toBe(screenSignature(dialog))
  })

  test("a four-screen dependent chain reaches the goal, driven by jev — not one step", () => {
    const target: Record<string, string> = {
      home: "0:c1 AXButton Products",
      products: "0:c1 AXButton Widget",
      // hardcode-guard:allow fixture option labels are the enumerable input under test
      widget: "0:c1 AXButton Proceed",
    }

    let map: NavMap | undefined
    let id = "home"
    const frontiers: string[][] = []
    const states: Record<string, unknown>[] = []
    const chosen: string[] = []
    const snapshotIds: string[] = []
    let status = "budget-exhausted"

    for (let step = 0; step < 8; step++) {
      const snapshot = `snap-${step}` // a FRESH snapshot id every observation
      snapshotIds.push(snapshot)
      const observation = observe(snapshot, shapes[id])
      const candidates = buildCandidates(observation.elements)
      map = advanceMap(GOAL, map, observation.elements, candidates.labels)
      frontiers.push([...candidates.labels])
      states.push(JSON.parse(buildState({ map })))

      // (c) CODE enumerates the option set BEFORE jev is asked; jev's answer is
      // keyed to exactly one enumerated option (never a choice jev invented).
      const q = buildControllerQuestions(map.frontier)
      const optionKeys = Object.keys(q?.target.criteria ?? {}).filter((k) => k !== "none")
      expect(optionKeys).toEqual(map.frontier.map((label, i) => `${i}:${label}`))

      const answers = id === "cart" ? { action: ans("done", { done: 0.99 }) } : ansOf(target[id])
      const { verdict } = decideAt(step, id === "cart", observation.elements, answers)
      if (verdict.kind === "stop") {
        status = verdict.reason
        break
      }
      if (verdict.kind !== "act") {
        status = verdict.kind
        break
      }
      chosen.push(verdict.element.label ?? "")
      const nextId = next[id][verdict.element.label ?? ""]
      if (!nextId) {
        status = "no-transition"
        break
      }
      id = nextId
    }

    // hardcode-guard:allow the expected jev-chosen labels are the fixture under test
    expect(chosen).toEqual(["Products", "Widget", "Proceed"])
    expect(status).toBe("evidence-satisfied")
    // Snapshot ids changed every observation, yet the path is SCREEN visits.
    expect(new Set(snapshotIds).size).toBe(snapshotIds.length)
    expect(map?.start).toBe(nodeId("home"))
    expect(map?.current).toBe(nodeId("cart"))
    expect(map?.path).toEqual(["home", "products", "widget", "cart"].map(nodeId))
    // every step changed the candidate set.
    expect(new Set(frontiers.map((f) => f.join("|"))).size).toBe(frontiers.length)
    // the state sent to jev carried the map, updated each step.
    expect(states.map((s) => s.current)).toEqual(["home", "products", "widget", "cart"].map(nodeId))
    expect(states[2].goal).toBe(GOAL)
    // hardcode-guard:allow the enumerated frontier is the fixture under test
    expect(states[2].frontier).toEqual(["c1 AXButton Proceed", "c2 AXButton Back"])
    expect(states[2].path).toEqual(["home", "products", "widget"].map(nodeId))
  })

  test("a branch that requires backtracking returns to the SAME node id", () => {
    // home -> products -> widget (dead end) -> Back -> products -> Gift -> gift -> cart,
    // with a fresh snapshot id on every observation.
    const script: ReadonlyArray<{ id: string; target?: string }> = [
      { id: "home", target: "0:c1 AXButton Products" },
      { id: "products", target: "0:c1 AXButton Widget" },
      { id: "widget", target: "1:c2 AXButton Back" },
      { id: "products", target: "1:c2 AXButton Gift" },
      { id: "gift", target: "0:c1 AXButton Add to cart" },
      { id: "cart" },
    ]

    let map: NavMap | undefined
    for (const [step, visit] of script.entries()) {
      const observation = observe(`bk-${step}`, shapes[visit.id])
      const candidates = buildCandidates(observation.elements)
      map = advanceMap(GOAL, map, observation.elements, candidates.labels)
      if (!visit.target) break
      const { verdict } = decideAt(step, false, observation.elements, ansOf(visit.target))
      expect(verdict.kind).toBe("act")
      if (verdict.kind !== "act") break
      // `Back` is legal only because code enumerated it in this node's frontier:
      // the chosen element is one of the enumerated candidates.
      // hardcode-guard:allow the identity assertion is the invariant, not a literal
      expect([...candidates.byLabel.values()].some((e) => e.element_token === verdict.element.element_token)).toBe(true)
    }

    expect(map?.path).toEqual(["home", "products", "widget", "products", "gift", "cart"].map(nodeId))
    // Backtracking returned to the SAME node id — a real revisit, not a new node.
    expect(map?.path[1]).toBe(map?.path[3])
    expect(map?.path[1]).toBe(nodeId("products"))
    expect(map?.path.filter((node) => node === nodeId("products")).length).toBe(2)
  })
})

describe("ui_run tool", () => {
  it.instance("reports a graceful not-connected result when cua-driver is absent", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* UiRunTool)
      expect(tool.id).toBe("ui_run")

      const result = yield* tool.execute({ goal: "g", window, steps: [{ intent: "click Settings" }] }, toolContext())

      expect(result.title).toBe("ui_run (unavailable)")
      expect(result.output).toBe("cua-driver MCP server is not connected")
    }),
  )
})