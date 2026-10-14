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
import { CONTROLS_MAX, LABEL_MAX, foldController } from "@/jev/controller"
import {
  Parameters,
  UiRunTool,
  buildCandidates,
  decideStep,
  decodeObservation,
  isDestructive,
  needsForegroundDelivery,
  normalizeExpect,
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