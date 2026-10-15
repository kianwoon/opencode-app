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
import { LABEL_MAX, buildControllerQuestions, buildState, foldController, type NavMap } from "@/jev/controller"
import {
  FRONTIER_HARD_MAX,
  MAX_BELOW_GATE,
  Parameters,
  UiRunTool,
  advanceMap,
  buildCandidates,
  decideStep,
  decodeObservation,
  extractGoalValue,
  isDestructive,
  isGoalMet,
  mineTrace,
  needsForegroundDelivery,
  nextAmbiguity,
  normalizeExpect,
  resolveTarget,
  screenSignature,
  traceStep,
  type StepTrace,
} from "@/tool/ui-run"
import { usableElements } from "@/tool/ui-eyes"
import {
  actuationPlan,
  changeEvidence,
  clickAttempt,
  clickSignals,
  clickVerdict,
  declaredAction,
  elementCenter,
  focusIdentity,
  targetState,
  type ClickSignals,
} from "@/tool/ui-hands"
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

  // hardcode-guard:allow the fixture mirrors the probed get_window_state wire shape verbatim
  test("decodes the probed driver wire shape: elements keyed `token`, snapshot s+8hex, 201 elements", () => {
    const wire = {
      snapshot_id: "s00000062",
      window_id: 7,
      pid: 4242,
      elements: Array.from({ length: 201 }, (_, i) => ({
        token: `s00000062:${i + 1}`,
        role: "AXButton",
        label: `web-${i}`,
      })),
    }
    const decoded = decodeObservation(wire)
    expect(decoded).not.toBeNull()
    expect(decoded?.snapshot_id).toBe("s00000062")
    expect(decoded?.elements.length).toBe(201)
    // the driver's `token` key is folded onto the canonical element_token
    expect(decoded?.elements[0].element_token).toBe("s00000062:1")

    const { labels, truncated } = buildCandidates(decoded?.elements ?? [])
    expect(labels.length).toBe(201) // every element usable — no key-alias drop
    expect(truncated).toBeUndefined()
    expect(labels.some((label) => label.includes("web-200"))).toBe(true)
  })

  test("both token spellings fold to the same canonical identity", () => {
    const viaToken = decodeObservation({
      snapshot_id: "s1",
      elements: [{ token: "s1:9", role: "AXButton", label: "Go" }],
    })
    const viaElementToken = decodeObservation({
      snapshot_id: "s1",
      elements: [{ element_token: "s1:9", role: "AXButton", label: "Go" }],
    })
    expect(viaToken?.elements[0].element_token).toBe("s1:9")
    expect(viaElementToken?.elements[0].element_token).toBe("s1:9")
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

  // hardcode-guard:allow the control-count literals are the enumerable screen size under test
  test("enumerates a real screen in full; only a pathological oversize is sampled and marked", () => {
    const realScreen = Array.from({ length: 159 }, (_, i) => button(i + 1, `control-${i}`))
    const full = buildCandidates(realScreen)
    expect(full.labels.length).toBe(159)
    expect(full.truncated).toBeUndefined()

    const oversize = Array.from({ length: FRONTIER_HARD_MAX + 5 }, (_, i) => button(i + 1, `label-${i}`))
    const sampled = buildCandidates(oversize)
    expect(sampled.labels.length).toBe(FRONTIER_HARD_MAX)
    expect(sampled.truncated).toContain("truncated")
    expect(sampled.truncated).toContain(String(FRONTIER_HARD_MAX + 5))
  })

  test("clips each label to LABEL_MAX and round-trips it to its element", () => {
    const { labels, byLabel } = buildCandidates([button(1, "x".repeat(300))])

    expect(labels[0].length).toBe(LABEL_MAX)
    expect(byLabel.get(labels[0])?.element_token).toBe("s00000011:1")
  })

  // hardcode-guard:allow fixture labels are the enumerable input under test
  test("a dense screen enumerates a goal target that sits past the old prefix", () => {
    const sidebar = Array.from({ length: 158 }, (_, i) => button(i + 1, `sidebar-${i}`))
    const goalTarget = button(200, "AppRow Toggle")
    const { labels, byLabel } = buildCandidates([...sidebar, goalTarget])

    expect(labels.length).toBe(159)
    // the target past the old contiguous prefix is a fully enumerated frontier option
    expect(labels.some((label) => label.includes("AppRow Toggle"))).toBe(true)
    expect([...byLabel.values()].some((e) => e.element_token === goalTarget.element_token)).toBe(true)
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

  // hardcode-guard:allow fixture labels/tokens are the churned identity input under test
  test("a target whose element token churned is re-resolved by role+label, not dropped", () => {
    const before = buildCandidates([button(1, "Save"), button(2, "Settings")])
    const chosen = before.labels[1] // "c2 AXButton Settings"
    const fresh = buildCandidates([button(9, "New"), button(1, "Save"), button(2, "Settings")])
    expect(fresh.byLabel.get(chosen)).toBeUndefined()

    const outcome = accepted({
      action: ans("click", { click: 0.9, wait: 0.1 }),
      target: ans(`0:${chosen}`, { [`0:${chosen}`]: 0.95, none: 0.05 }),
    })
    const v = decideStep({ ...base, outcome, candidates: fresh })
    expect(v.kind).toBe("act")
    if (v.kind !== "act") throw new Error("expected act")
    expect(v.element.label).toBe("Settings")
    expect(v.element.element_token).toBe("s00000011:2")
  })

  // hardcode-guard:allow fixture labels/tokens are the churned identity input under test
  test("resolveTarget ignores the churned cN prefix and matches on role+label", () => {
    const elements = [button(9, "New"), button(2, "Settings")]
    expect(resolveTarget("c2 AXButton Settings", elements)?.element_token).toBe("s00000011:2")
    expect(resolveTarget("c7 AXButton Settings", elements)?.element_token).toBe("s00000011:2")
    expect(resolveTarget("c1 AXButton Missing", elements)).toBeUndefined()
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

// hardcode-guard:allow fixture labels and answers are the enumerable input under test
describe("nextAmbiguity", () => {
  test("an action whose screen is unchanged advances the count", () => {
    expect(nextAmbiguity(0, "n1", "n1")).toBe(1)
    expect(nextAmbiguity(2, "n1", "n1")).toBe(3)
  })

  test("an action that changes the screen resets the count", () => {
    expect(nextAmbiguity(2, "n1", "n2")).toBe(0)
  })

  test("no action last iteration leaves the count untouched", () => {
    expect(nextAmbiguity(1, undefined, "n9")).toBe(1)
  })

  test("a repeated no-op click terminates via the ambiguity bound, not the budget", () => {
    const elements = [button(1, "Notifications"), button(2, "Do Not Disturb")]
    const candidates = buildCandidates(elements)
    const target = candidates.labels[0]
    let ambiguous = 0
    let actedAt: string | undefined
    let status = "budget-exhausted"

    for (let step = 0; step < 30; step++) {
      // the SAME screen is observed every iteration — the click never moves it
      const map = advanceMap("open the app's notification settings", undefined, elements, candidates.labels)
      ambiguous = nextAmbiguity(ambiguous, actedAt, map.current)
      const outcome = accepted({
        action: ans("click", { click: 0.95, wait: 0.05 }),
        target: ans(`0:${target}`, { [`0:${target}`]: 0.95, none: 0.05 }),
      })
      const verdict = decideStep({
        outcome,
        candidates: { labels: candidates.labels, byLabel: candidates.byLabel },
        goalMet: false,
        evidence: false,
        step,
        maxSteps: 30,
        ambiguous,
        maxAmbiguous: 3,
      })
      if (verdict.kind !== "act") {
        status = verdict.reason
        break
      }
      actedAt = map.current
    }

    expect(status).toBe("ambiguous-limit")
  })
})

// hardcode-guard:allow fixture labels and answers are the enumerable input under test
describe("traceStep", () => {
  const base = {
    candidates: index([button(1, "Save"), button(2, "Settings")]),
    goalMet: false,
    evidence: false,
    step: 0,
    maxSteps: 30,
    ambiguous: 0,
    maxAmbiguous: 3,
  }

  test("an accepted decision carries action + target + strength", () => {
    const outcome = accepted({
      action: ans("click", { click: 0.9, wait: 0.1 }),
      target: ans("0:c2 AXButton Settings", { "0:c2 AXButton Settings": 0.95, none: 0.05 }),
    })
    const verdict = decideStep({ ...base, outcome })
    expect(traceStep(1, outcome, verdict)).toEqual({
      step: 1,
      verdict: "accepted",
      action: "click",
      target: "c2 AXButton Settings",
      strength: 0.9,
      decision: "act",
      reason: "decided",
    })
  })

  test("a below_gate verdict carries its strength and no action", () => {
    const outcome = foldController({ answers: { action: ans("click", { click: 0.55, wait: 0.45 }) } }, 0.7)
    const verdict = decideStep({ ...base, outcome })
    const t = traceStep(1, outcome, verdict)
    expect(t.verdict).toBe("below_gate")
    expect(t.action).toBeNull()
    expect(t.target).toBeNull()
    expect(t.strength).toBeCloseTo(0.55)
    expect(t.decision).toBe("safe")
    expect(t.reason).toBe("below-gate")
  })

  test("an unmeasured verdict carries no action and no strength", () => {
    const outcome = foldController({}, 0.7)
    const verdict = decideStep({ ...base, outcome })
    const t = traceStep(1, outcome, verdict)
    expect(t.verdict).toBe("unmeasured")
    expect(t.action).toBeNull()
    expect("strength" in t).toBe(false)
    expect(t.reason).toBe("unmeasured")
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

  // hardcode-guard:allow the differing frame/actions are the ephemeral fields under test
  test("signature ignores ephemeral frame and declared actions, not just snapshot/token", () => {
    const a = [
      { element_token: "s1:1", role: "AXButton", label: "Go", actions: ["AXPress"], frame: { x: 0, y: 0, width: 1, height: 1 } },
    ]
    const b = [
      { element_token: "s2:9", role: "AXButton", label: "Go", actions: ["AXSelect"], frame: { x: 5, y: 5, width: 9, height: 9 } },
    ]
    expect(screenSignature(a)).toBe(screenSignature(b))
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

// hardcode-guard:allow fixture frames/actions are the declared-actuation input under test
describe("hands actuation (declared action + pixel fallback)", () => {
  const win = { pid: 4242, window_id: 7 }

  test("an AXRow maps to a declared select/pick and still offers the pixel fallback", () => {
    const row = {
      element_token: "s1:1",
      role: "AXRow",
      label: "Wallpaper",
      actions: ["AXSelect"],
      frame: { x: 100, y: 200, width: 40, height: 20 },
    }
    expect(declaredAction(row)).toBe("pick")
    const plan = actuationPlan(row, win)
    expect(plan.map((r) => r.mode)).toEqual(["declared", "pixel"])
    expect(plan[0].args).toMatchObject({ element_token: "s1:1", action: "pick" })
    expect(plan[1].args).toMatchObject({ x: 120, y: 210, delivery_mode: "foreground" })
  })

  test("a declared AXPress is the first rung; the pixel rung follows at the frame centre", () => {
    const pressable = {
      element_token: "s1:2",
      role: "AXButton",
      label: "Apply",
      actions: ["AXPress"],
      frame: { x: 10, y: 10, width: 100, height: 40 },
    }
    expect(declaredAction(pressable)).toBe("press")
    const plan = actuationPlan(pressable, win)
    expect(plan[0]).toMatchObject({ mode: "declared", label: "press" })
    expect(plan[0].args).toMatchObject({ action: "press" })
    expect(plan[1]).toMatchObject({ mode: "pixel", label: "pixel(60,30)" })
  })

  test("no frame means no pixel rung — the declared action is the only rung", () => {
    const pressable = { element_token: "s1:3", role: "AXButton", label: "OK", actions: ["AXPress"] }
    expect(actuationPlan(pressable, win).map((r) => r.mode)).toEqual(["declared"])
  })

  test("an element with no declared action and no role default falls to a plain element click", () => {
    const mystery = { element_token: "s1:4", role: "AXGroup", label: "canvas" }
    expect(declaredAction(mystery)).toBeUndefined()
    const plan = actuationPlan(mystery, win)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ mode: "declared", label: "click", args: { element_token: "s1:4" } })
  })

  test("changeEvidence reports the before/after screen delta, never a bare boolean", () => {
    expect(changeEvidence("declared", "n1", "n2")).toEqual({
      mode: "declared",
      before: "n1",
      after: "n2",
      changed: true,
    })
    expect(changeEvidence("pixel", "n1", "n1").changed).toBe(false)
  })
})

// GENERALIZATION — the invariant: click DELIVERY is measured in OBSERVABLE WORLD
// STATE across multiple signals (screen signature, the target's own state, focus),
// never in the driver's success codes; a click that cannot be proven to have
// worked is reported failed, never silently absorbed. The silent no-op class — a
// wallpaper swatch that absorbs the click, AXPress on an AXRow returning -25206 —
// is instances of "driver said ok, world unchanged". UNSEEN CASE COVERED: a click
// that only moves FOCUS onto its target (screen unchanged) still delivers.
// hardcode-guard:allow the captured payload IS the artifact under test; the gate requires the exact captured shape.
describe("affirmative click delivery (multi-signal world state)", () => {
  const CAPTURE = path.join(import.meta.dir, "fixtures", "brave-window-capture.json")
  const win = { pid: 4242, window_id: 7 }
  const unchanged = (signals: ClickSignals): ClickSignals => ({ ...signals })

  test("the target's OWN state is captured from the fixture's selected/value fields", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const withValue = observation.elements.find((e) => e.value !== undefined)
    expect(withValue).toBeDefined()
    if (withValue === undefined) return
    expect(targetState(withValue)).toContain(withValue.value as string)
    expect(targetState({ ...withValue, selected: !withValue.selected })).not.toBe(targetState(withValue))
  })

  test("(a) a rung-1 TARGET-STATE change is delivered on rung 1 — no escalation", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const field = observation.elements.find((e) => e.role === "AXTextField")
    if (field === undefined) throw new Error("fixture must hold an address field")
    const plan = actuationPlan(field, win)
    const before = clickSignals("nA", field, observation.elements)
    // the field's own value changes; the screen signature does NOT
    const afterElements = observation.elements.map((e) => (e === field ? { ...e, value: "https://x.test" } : e))
    const after = clickSignals("nA", field, afterElements)

    const attempt1 = clickAttempt(plan[0], before, after, field)
    expect(attempt1.delivered).toBe(true)
    expect(attempt1.reasons).toContain("target-state")
    expect(attempt1.reasons).not.toContain("screen")

    const verdict = clickVerdict([attempt1])
    expect(verdict.worked).toBe(true)
    expect(verdict.attempts).toHaveLength(1)
    expect(verdict.mode).toBe("declared")
  })

  test("(b) rung 1 leaves everything unchanged → escalates to pixel, delivers on a signature change", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const button = observation.elements.find((e) => e.role === "AXButton")
    if (button === undefined) throw new Error("fixture must hold a button")
    const plan = actuationPlan(button, win)
    expect(plan.map((r) => r.mode)).toEqual(["declared", "pixel"])
    const before = clickSignals("nA", button, observation.elements)

    const attempt1 = clickAttempt(plan[0], before, unchanged(before), button)
    expect(attempt1.delivered).toBe(false)
    const attempt2 = clickAttempt(plan[1], before, { ...before, screen: "nB" }, button)
    expect(attempt2.delivered).toBe(true)
    expect(attempt2.reasons).toContain("screen")

    const verdict = clickVerdict([attempt1, attempt2])
    expect(verdict.worked).toBe(true)
    expect(verdict.mode).toBe("pixel")
    expect(verdict.attempts).toHaveLength(2)
  })

  test("(c) BOTH rungs change nothing → worked:false with both attempts' evidence, feeding the bound", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const button = observation.elements.find((e) => e.role === "AXButton")
    if (button === undefined) throw new Error("fixture must hold a button")
    const plan = actuationPlan(button, win)
    const before = clickSignals("nA", button, observation.elements)

    const attempt1 = clickAttempt(plan[0], before, unchanged(before), button, "driver reports ok")
    const attempt2 = clickAttempt(plan[1], before, unchanged(before), button, "driver reports ok")
    const verdict = clickVerdict([attempt1, attempt2])
    expect(verdict.worked).toBe(false)
    expect(verdict.attempts).toHaveLength(2)
    expect(verdict.attempts.map((a) => a.delivered)).toEqual([false, false])
    expect(verdict.attempts.every((a) => a.reasons.length === 0)).toBe(true)

    // the loop feeds an undelivered click to the ambiguity bound: it ran at the
    // node and changed nothing, so the unchanged screen advances the count.
    expect(nextAmbiguity(0, "nA", "nA")).toBe(1)
    expect(nextAmbiguity(2, "nA", "nA")).toBe(3)
  })

  test("focus-only delivery: a click that moves focus ONTO its target is delivered (unseen case)", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const button = observation.elements.find((e) => e.role === "AXButton")
    if (button === undefined) throw new Error("fixture must hold a button")
    const plan = actuationPlan(button, win)
    const before = { screen: "nA", target: targetState(button) } as ClickSignals
    const afterElements = observation.elements.map((e) => (e === button ? { ...e, focused: true } : e))
    const after = clickSignals("nA", button, afterElements)
    expect(after.focus).toBe(focusIdentity(button))

    const attempt = clickAttempt(plan[0], before, after, button)
    expect(attempt.delivered).toBe(true)
    expect(attempt.reasons).toContain("focus")
    expect(attempt.reasons).not.toContain("screen")
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

// GENERAL RULE (mirrors ui-eyes.ts): the wire schema mirrors the DRIVER's field
// vocabulary at EVERY nesting depth, not just top-level keys. The captured Brave
// `get_window_state` payload keys each frame `{x, y, w, h}` while the canonical
// shape is `{x, y, width, height}`; the NESTED frame decoder aliases and
// normalizes, so a nested key-name change decodes instead of reading "Expected
// object". This 78/78 failure is one instance; an unseen nested variant it
// covers is a driver that ships `bounds` (not `frame`) under the same `w`/`h`
// spelling — the override applies to both fields identically.
// hardcode-guard:allow regression fixture — the captured payload IS the artifact under test; gate (a)/(b) require the exact captured shape, not synthesized values.
describe("ui-eyes — driver frame vocabulary", () => {
  const CAPTURE = path.join(import.meta.dir, "fixtures", "brave-window-capture.json")

  test("decodes the captured Brave payload: all 78 rows usable from the driver's {x,y,w,h} vocabulary", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    expect(observation).not.toBeNull()
    if (observation === null) return
    expect(observation.snapshot_id).toBe("s00000067")
    // full 78-row shape: every element decodes, every nested frame normalizes
    expect(raw.elements).toHaveLength(78)
    expect(observation.elements).toHaveLength(78)
    expect(
      observation.elements.every((e) => typeof e.frame?.width === "number" && typeof e.frame?.height === "number"),
    ).toBe(true)
    // the driver's own `w`/`h` are preserved as `width`/`height`, row for row
    expect(
      observation.elements.every(
        (e, i) => e.frame?.width === raw.elements[i].frame.w && e.frame?.height === raw.elements[i].frame.h,
      ),
    ).toBe(true)
    // the 54 interactive rows become candidates (AXStaticText/AXImage excluded)
    expect(usableElements(observation.elements)).toHaveLength(54)
  })

  test("the pixel fallback centre math holds on a {x,y,w,h} frame", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    expect(observation).not.toBeNull()
    const back = observation?.elements.find((e) => e.label === "Back")
    expect(back?.frame).toEqual({ x: 4595, y: 320, width: 28, height: 28 })
    // centre = (x + width/2, y + height/2) → (4595 + 14, 320 + 14)
    expect(elementCenter(back!)).toEqual({ x: 4609, y: 334 })
    const plan = actuationPlan(back!, { pid: raw.pid, window_id: raw.window_id })
    expect(plan.map((r) => r.label)).toContain("pixel(4609,334)")
  })
})

// GENERALIZATION — three live failures, three invariants:
//  (1) VALUES come from the GOAL, not the option space (extractGoalValue): a
//      chooser over enumerated controls cannot choose arbitrary text.
//  (2) DEGRADATION takes the safest strongest action rather than stalling.
//  (3) PREREQUISITE focus steps are progress, not no-ops.
// Each live failure is one instance; unseen cases are named per test.
// hardcode-guard:allow the captured payload + quoted URL are the live inputs under test
describe("extractGoalValue", () => {
  test("takes the quoted token the goal carries", () => {
    expect(extractGoalValue(`go to "https://www.linkedin.com" and sign in`)).toBe("https://www.linkedin.com")
    expect(extractGoalValue("search for 'wireless headphones'")).toBe("wireless headphones")
  })

  test("falls back to a bare URL when nothing is quoted (unseen case: unquoted value)", () => {
    expect(extractGoalValue("open https://example.com/path now")).toBe("https://example.com/path")
    expect(extractGoalValue("no value here")).toBeUndefined()
  })
})

describe("decideStep — graceful degradation at the below-gate bound", () => {
  const candidates = index([button(1, "Settings"), button(2, "Save")])
  const belowGate = accepted({
    action: ans("click", { click: 0.5, wait: 0.5 }),
    target: ans("0:c1 AXButton Settings", { "0:c1 AXButton Settings": 0.5, none: 0.5 }),
  })
  const base = {
    candidates,
    goalMet: false,
    evidence: false,
    step: 0,
    maxSteps: 30,
    ambiguous: 0,
    maxAmbiguous: 3,
  }

  test("before the bound a below-gate step still falls safe", () => {
    const v = decideStep({ ...base, outcome: belowGate, belowGate: MAX_BELOW_GATE - 1, maxBelowGate: MAX_BELOW_GATE })
    expect(v.kind).toBe("safe")
  })

  test("at the bound it takes the strongest option and records strongest-available-fallback", () => {
    const v = decideStep({
      ...base,
      outcome: belowGate,
      belowGate: MAX_BELOW_GATE,
      maxBelowGate: MAX_BELOW_GATE,
      strongestBelowGate: { action: "click", target: "c1 AXButton Settings", strength: 0.66 },
    })
    expect(v.kind).toBe("act")
    if (v.kind !== "act") throw new Error("expected act")
    expect(v.reason).toBe("strongest-available-fallback")
    expect(v.element.label).toBe("Settings")
  })

  test("a destructive strongest option is REFUSED below gate, falling safe (never destructive)", () => {
    const v = decideStep({
      ...base,
      outcome: accepted({
        action: ans("click", { click: 0.5, wait: 0.5 }),
        target: ans("0:c2 AXButton Save", { "0:c2 AXButton Save": 0.5, none: 0.5 }),
      }),
      belowGate: MAX_BELOW_GATE,
      maxBelowGate: MAX_BELOW_GATE,
    })
    expect(v.kind).toBe("safe")
  })

  test("a scroll among the options cannot degrade to an act (unseen case: non-click option)", () => {
    const v = decideStep({
      ...base,
      outcome: accepted({ action: ans("scroll", { scroll: 0.5, click: 0.5 }) }),
      belowGate: MAX_BELOW_GATE,
      maxBelowGate: MAX_BELOW_GATE,
    })
    expect(v.kind).toBe("safe")
  })
})

describe("nextAmbiguity — prerequisite focus is not a no-op", () => {
  test("a content-unchanged focus click followed by type on the SAME target does not advance", () => {
    expect(
      nextAmbiguity(0, "n1", "n1", {
        actedMode: "declared",
        actedTarget: "c1 AXTextField Search",
        nextAction: "type",
        nextTarget: "c1 AXTextField Search",
      }),
    ).toBe(0)
  })

  test("a repeated click on the same target is still a no-op (existing bound preserved)", () => {
    expect(
      nextAmbiguity(0, "n1", "n1", {
        actedMode: "declared",
        actedTarget: "c1 AXButton X",
        nextAction: "click",
        nextTarget: "c1 AXButton X",
      }),
    ).toBe(1)
  })

  test("a changed screen still resets regardless of target", () => {
    expect(
      nextAmbiguity(2, "n1", "n2", {
        actedMode: "declared",
        actedTarget: "c1 AXTextField Search",
        nextAction: "type",
        nextTarget: "c1 AXTextField Search",
      }),
    ).toBe(0)
  })
})

describe("ui_run chain — decider contract over the captured Brave frontier", () => {
  const CAPTURE = path.join(import.meta.dir, "fixtures", "brave-window-capture.json")

  test("click address-bar (focus, unchanged) → type the goal's URL → screen changes", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    expect(observation).not.toBeNull()
    if (observation === null) return
    const candidates = buildCandidates(observation.elements)
    const addressBar = candidates.labels.find((l) => l.includes("Address and search bar"))
    expect(addressBar).toBeDefined()
    if (addressBar === undefined) return
    const index0 = { labels: candidates.labels, byLabel: candidates.byLabel }
    const goal = `go to "https://www.linkedin.com" and sign in`
    expect(extractGoalValue(goal)).toBe("https://www.linkedin.com")

    // Step 1 — jev clicks the address bar; the field only gains focus (screen Unchanged).
    const node = screenSignature(observation.elements)
    const clickVerdict = decideStep({
      outcome: accepted({
        action: ans("click", { click: 0.92, wait: 0.08 }),
        target: ans(`0:${addressBar}`, { [`0:${addressBar}`]: 0.95, none: 0.05 }),
      }),
      candidates: index0,
      goalMet: false,
      evidence: false,
      goal,
      step: 0,
      maxSteps: 30,
      ambiguous: 0,
      maxAmbiguous: 3,
    })
    expect(clickVerdict.kind).toBe("act")
    // The successor is a type on the SAME target, so the focus click must NOT count.
    const ambiguousAfterFocus = nextAmbiguity(0, node, node, {
      actedMode: "declared",
      actedTarget: addressBar,
      nextAction: "type",
      nextTarget: addressBar,
    })
    expect(ambiguousAfterFocus).toBe(0)

    // Step 2 — jev types on the same field; the value comes from the GOAL (not the
    // option space), so the decision carries text rather than dying "type-without-text".
    const typeVerdict = decideStep({
      outcome: accepted({
        action: ans("type", { type: 0.9, click: 0.1 }),
        target: ans(`0:${addressBar}`, { [`0:${addressBar}`]: 0.95, none: 0.05 }),
      }),
      candidates: index0,
      goalMet: false,
      evidence: false,
      goal,
      step: 1,
      maxSteps: 30,
      ambiguous: ambiguousAfterFocus,
      maxAmbiguous: 3,
    })
    expect(typeVerdict.kind).toBe("act")
    if (typeVerdict.kind !== "act") return
    expect(typeVerdict.action).toBe("type")
    expect(typeVerdict.text).toBe("https://www.linkedin.com")
    expect(typeVerdict.element.label).toBe("Address and search bar")

    // Step 3 — the type changes the screen: the ambiguity count resets (progress).
    const changed = screenSignature([
      ...observation.elements,
      { role: "AXButton", label: "New posts", element_token: "s00000067:99" },
    ])
    expect(changed).not.toBe(node)
    expect(
      nextAmbiguity(ambiguousAfterFocus, node, changed, {
        actedMode: "type",
        actedTarget: addressBar,
        nextAction: "click",
        nextTarget: "c1 AXButton New posts",
      }),
    ).toBe(0)
  })
})

// GENERALIZATION — the invariant: mining FLAGS promotion candidates from the run
// trace; it never self-promotes into the registry. The per-case-feeding problem is
// the instance this closes; an unseen case it covers is a repeated key→key chord
// (e.g. tab→enter) on the same target.
// hardcode-guard:allow fixture labels/tokens are the enumerable input under test
describe("ui_run — skill mining hook over the step trace", () => {
  const act = (step: number, action: "click" | "type", target: string, progressed: boolean): StepTrace => ({
    step,
    verdict: "accepted",
    action,
    target,
    decision: "act",
    reason: "decided",
    ...(action === "click"
      ? { click: { worked: progressed, mode: "declared" as const, attempts: [] } }
      : { actuation: { mode: "type" as const, before: "nA", after: progressed ? "nB" : "nA", changed: progressed } }),
  })

  test("(c) repeated delivered focus→type steps emit a promotion candidate from the trace", () => {
    const candidates = mineTrace([
      act(1, "click", "c1 AXTextField Search", true),
      act(2, "type", "c1 AXTextField Search", true),
      act(3, "click", "c1 AXTextField Search", true),
      act(4, "type", "c1 AXTextField Search", true),
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].occurrences).toBe(2)
    expect(candidates[0].sequence).toEqual(["click c1 AXTextField Search", "type c1 AXTextField Search"])
  })

  test("(c) a clean trace (no repetition / nothing progressed) emits no candidate", () => {
    expect(mineTrace([act(1, "click", "X", true), act(2, "type", "Y", true)])).toEqual([])
    expect(
      mineTrace([
        act(1, "click", "X", false),
        act(2, "type", "X", false),
        act(3, "click", "X", false),
        act(4, "type", "X", false),
      ]),
    ).toEqual([])
  })
})