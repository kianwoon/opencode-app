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
import { LABEL_MAX } from "@/jev/controller"
import {
  FRONTIER_HARD_MAX,
  GATE_FLOOR,
  MAX_MANEUVER_REPEATS,
  Parameters,
  UiRunTool,
  advanceMap,
  decodeObservation,
  destructiveManeuver,
  extractGoalValue,
  initialManeuverRepeat,
  isDestructive,
  loginWall,
  maneuverRepeatStep,
  minePlan,
  mineTrace,
  needsForegroundDelivery,
  nextAmbiguity,
  normalizeExpect,
  planLoop,
  planSummary,
  resolveTarget,
  runClickRungs,
  runTypeDelivery,
  runUrlEntry,
  screenSignature,
  stateChangingManeuver,
  type DriverCall,
  type DriverOutcome,
  type PlanLoopDeps,
  type PlanLoopTelemetry,
  type StepTrace,
} from "@/tool/ui-run"
import type { ManeuverOption } from "@/tool/ui-maneuvers"
import type { Scene, SceneItem, SceneRegion } from "@/tool/ui-scene"
import { buildCandidates, usableElements, type Element } from "@/tool/ui-eyes"
import {
  CLIPBOARD_REPLACED_NOTE,
  actuationPlan,
  changeEvidence,
  clickAttempt,
  clickSignals,
  clickVerdict,
  declaredAction,
  elementCenter,
  focusIdentity,
  frameEstablishingRead,
  hotkeyArgs,
  isNoFrameError,
  observationArgs,
  pixelFrameRetry,
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

// GENERALIZATION — INVARIANT: a SENSOR-DEPENDENT actuator establishes the sensor
// state it needs ON DEMAND, while an OBSERVER optimizes its own payload
// independently. The live failure — a pixel click erroring "No screenshot frame"
// because every loop observation requested include_screenshot:false — is ONE
// instance. UNSEEN CASE COVERED: a second sensor-dependent actuator needing a
// frame (a contrast/OCR probe) establishes it the same way, never by widening
// observer payloads.
// hardcode-guard:allow the driver's refusal token and the capture are the live inputs under test
describe("on-demand sensor establishment (pixel frame)", () => {
  const CAPTURE = path.join(import.meta.dir, "fixtures", "brave-window-capture.json")
  const win = { pid: 4242, window_id: 7 }
  const unchanged = (signals: ClickSignals): ClickSignals => ({ ...signals })
  const NO_FRAME =
    "No screenshot frame for window 7: its latest read had no screenshot and the window changed size since the last one (or it was never captured)"

  test("(c) the loop's own observation payload stays cheap; only the frame-establishing read carries a screenshot", () => {
    expect(observationArgs(win)).toEqual({
      pid: 4242,
      window_id: 7,
      include_screenshot: false,
      tree_format: "elements",
    })
    expect(frameEstablishingRead(win)).toEqual({
      pid: 4242,
      window_id: 7,
      include_screenshot: true,
      tree_format: "elements",
    })
    expect(isNoFrameError(NO_FRAME)).toBe(true)
    expect(isNoFrameError("driver reports ok")).toBe(false)
  })

  test("(a) a pixel rung reporting no frame establishes ONE frame, then the retry is judged by world state", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const button = observation.elements.find((e) => e.role === "AXButton")
    if (button === undefined) throw new Error("fixture must hold a button")
    const plan = actuationPlan(button, win)
    expect(plan.map((r) => r.mode)).toEqual(["declared", "pixel"])
    const before = clickSignals("nA", button, observation.elements)

    // rung 1 (declared) changes nothing; rung 2 (pixel) fails for lack of a frame.
    const declared = clickAttempt(plan[0], before, unchanged(before), button)
    expect(declared.delivered).toBe(false)
    expect(pixelFrameRetry(plan[1], NO_FRAME, false)).toBe(true)
    expect(frameEstablishingRead(win).include_screenshot).toBe(true)

    // the establishing read supplies the after-capture; the retried pixel attempt
    // delivers on the screen signal — judged by the same multi-signal evidence.
    const pixelFailed = clickAttempt(plan[1], before, unchanged(before), button, NO_FRAME)
    const pixelRetry = clickAttempt(plan[1], before, { ...before, screen: "nB" }, button)
    const verdict = clickVerdict([declared, pixelFailed, pixelRetry])
    expect(verdict.worked).toBe(true)
    expect(verdict.mode).toBe("pixel")
    expect(pixelRetry.reasons).toContain("screen")
  })

  test("(b) a still-failing retry returns worked:false with the full three-attempt chain", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const button = observation.elements.find((e) => e.role === "AXButton")
    if (button === undefined) throw new Error("fixture must hold a button")
    const plan = actuationPlan(button, win)
    const before = clickSignals("nA", button, observation.elements)

    const declared = clickAttempt(plan[0], before, unchanged(before), button)
    const pixelFailed = clickAttempt(plan[1], before, unchanged(before), button, NO_FRAME)
    const pixelRetry = clickAttempt(plan[1], before, unchanged(before), button)
    const verdict = clickVerdict([declared, pixelFailed, pixelRetry])
    expect(verdict.worked).toBe(false)
    expect(verdict.attempts).toHaveLength(3)
    expect(verdict.attempts.map((a) => a.mode)).toEqual(["declared", "pixel", "pixel"])
    expect(verdict.attempts[1].error).toContain("No screenshot frame")
    expect(verdict.attempts.every((a) => a.delivered)).toBe(false)
  })

  test("pixelFrameRetry fires only for an unestablished pixel rung with the no-frame error", () => {
    const plan = actuationPlan(
      {
        element_token: "s1:9",
        role: "AXButton",
        label: "B",
        actions: ["AXPress"],
        frame: { x: 0, y: 0, width: 10, height: 10 },
      },
      win,
    )
    expect(pixelFrameRetry(plan[0], NO_FRAME, false)).toBe(false)
    expect(pixelFrameRetry(plan[1], NO_FRAME, true)).toBe(false)
    expect(pixelFrameRetry(plan[1], "some other error", false)).toBe(false)
    expect(pixelFrameRetry(plan[1], NO_FRAME, false)).toBe(true)
  })
})

// GENERALIZATION — the SAME shared rung runner drives both call sites (the main
// loop and executeSkill's click sub-step), so a skill click sub-step cannot keep a
// latent no-frame bug the main loop fixed. INVARIANT: a sensor-dependent actuator
// establishes its sensor state on demand. The source-scan test below confirms no
// other pixel/click call site bypasses the helper.
// hardcode-guard:allow the driver's refusal token is the live error under test
describe("runClickRungs — the shared click rung runner", () => {
  const win = { pid: 4242, window_id: 7 }
  const NO_FRAME =
    "No screenshot frame for window 7: its latest read had no screenshot and the window changed size since the last one"
  const tree = (label: string) => ({ snapshot_id: "s1", elements: [{ token: "t1", role: "AXButton", label }] })

  const makeDriver = (script: DriverOutcome[]) => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed(script.shift() ?? { ok: false, error: "unscripted" })
    }
    return { call, calls }
  }

  test("(a) a pixel rung reporting no frame establishes ONE frame then retries — a skill sub-step's path", async () => {
    const button = {
      element_token: "t1",
      role: "AXButton",
      label: "Go",
      actions: ["AXPress"],
      frame: { x: 0, y: 0, width: 10, height: 10 },
    }
    const plan = actuationPlan(button, win)
    expect(plan.map((r) => r.mode)).toEqual(["declared", "pixel"])
    // the "before" screen IS the unchanged tree's signature, so the declared probe reads no change
    const unchanged = decodeObservation(tree("Go"))
    if (unchanged === null) throw new Error("tree must decode")
    const before = clickSignals(screenSignature(unchanged.elements), button, unchanged.elements)

    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // declared click
      { ok: true, result: { content: [], structuredContent: tree("Go") } }, // probe: unchanged
      { ok: false, error: NO_FRAME }, // pixel click: no frame
      { ok: true, result: { content: [], structuredContent: tree("Go") } }, // frame-establishing read: unchanged
      { ok: true, result: { content: [] } }, // retried pixel click
      { ok: true, result: { content: [], structuredContent: tree("Gone") } }, // probe: screen changed → delivered
    ])

    const run = await Effect.runPromise(runClickRungs(driver.call, win, button, plan, before, before.screen))

    // exactly ONE frame-establishing read, carrying a screenshot
    const frameReads = driver.calls.filter(
      (c) => c.name === "cua-driver_get_window_state" && c.args.include_screenshot === true,
    )
    expect(frameReads).toHaveLength(1)
    // the pixel rung was attempted twice: the no-frame attempt, then the retry
    const pixelClicks = driver.calls.filter((c) => c.name === "cua-driver_click" && c.args.x !== undefined)
    expect(pixelClicks).toHaveLength(2)
    // delivery is judged by the multi-signal world state, on the retried attempt
    expect(run.outcome.worked).toBe(true)
    expect(run.outcome.mode).toBe("pixel")
    expect(run.attempts.map((a) => a.mode)).toEqual(["declared", "pixel", "pixel"])
    expect(run.attempts[2].reasons).toContain("screen")
  })

  test("(b)/(d) both call sites use the one runner; no click call site bypasses it", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "tool", "ui-run.ts")).text()
    // the two call sites (main loop + executeSkill) both delegate to the helper...
    expect(src.match(/yield\* runClickRungs\(/g) ?? []).toHaveLength(2)
    // ...and NO click / frame-retry logic remains outside the helper region
    const callSites = src.slice(src.indexOf("export const UiRunTool"))
    expect(callSites.includes("cua-driver_click")).toBe(false)
    expect(callSites.includes("pixelFrameRetry(")).toBe(false)
  })
})

// GENERALIZATION — INVARIANT: sanctioned REAL-input delivery outranks accessibility
// insertion where the target surface is known to drop it. executeSkill's keystroke
// sub-step delivers the text as real per-character key events, never type_text —
// Chromium's address bar is the one live instance; an unseen surface that drops
// insertion is delivered the same way. The source scan confirms the wiring.
// hardcode-guard:allow the driver tool names are the wiring contract under test
// GENERALIZATION — INVARIANT: partial actuator output is RESUMABLE and must be
// driven to completion, never submitted half-typed. The live `type_text`
// "delivered 6 of 24 … retry only the remaining suffix" report is one instance;
// any second partial-delivery actuator is resumed by the SAME runner.
// hardcode-guard:allow the driver's partial-delivery report is the live input under test
describe("runTypeDelivery — resumable text delivery", () => {
  const win = { pid: 4242, window_id: 7 }
  const el = { element_token: "t1", role: "AXTextField", label: "Address and search bar" }
  const TEXT = "https://www.linkedin.com"
  const PARTIAL =
    "type_text incomplete: delivered 6 of 24 character(s) via foreground keystrokes (30ms delay); retry only the remaining suffix"

  test("(a) a partial report is resumed with ONLY the remaining suffix, in foreground", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const script: DriverOutcome[] = [
      { ok: false, error: PARTIAL },
      { ok: true, result: { content: [] } },
    ]
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed(script.shift() ?? { ok: false, error: "unscripted" })
    }
    const run = await Effect.runPromise(runTypeDelivery(call, win, el, TEXT))
    expect(run.completed).toBe(true)
    expect(run.delivered).toBe(24)
    expect(run.rounds).toBe(2)
    expect(run.failure).toBeUndefined()
    expect(calls.map((c) => c.name)).toEqual(["cua-driver_type_text", "cua-driver_type_text"])
    expect(calls[0].args.text).toBe(TEXT)
    expect(calls[1].args.text).toBe(TEXT.slice(6))
    expect(calls.every((c) => c.args.delivery_mode === "foreground")).toBe(true)
  })

  test("(a) BOUNDED: repeated partials stop at the round cap with delivered < total", async () => {
    const call: DriverCall = () => Effect.succeed({ ok: false, error: "delivered 1 of 24 character(s); retry the remaining suffix" })
    const run = await Effect.runPromise(runTypeDelivery(call, win, el, TEXT))
    expect(run.completed).toBe(false)
    expect(run.rounds).toBe(3)
    expect(run.delivered).toBe(3)
    expect(run.failure).toBeDefined()
  })
})

describe("executeSkill — keystroke route wiring", () => {
  test("(a)/(d) the keys sub-step drives cua-driver_press_key per character, not accessibility insertion", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "tool", "ui-run.ts")).text()
    const skillRegion = src.slice(src.indexOf("const executeSkill"), src.indexOf("for (let step = 0"))
    expect(skillRegion.includes('sub.kind === "keys"')).toBe(true)
    expect(skillRegion.includes("keySequence(")).toBe(true)
  })

  // hardcode-guard:allow the prepare verb + driver tool name are the wiring contract under test
  test("(a) the prepare sub-step drives cua-driver_browser_prepare and stops honestly on failure", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "tool", "ui-run.ts")).text()
    const skillRegion = src.slice(src.indexOf("const executeSkill"), src.indexOf("for (let step = 0"))
    expect(skillRegion.includes('sub.kind === "prepare"')).toBe(true)
    expect(skillRegion.includes("cua-driver_browser_prepare")).toBe(true)
    // a failed prepare records the driver error as the skill's failure (honest stop)
    expect(skillRegion.includes("failure = prepared.error")).toBe(true)
  })

  // hardcode-guard:allow the freshness/policy/delivery wiring is the hand contract under test
  test("(a)/(b)/(c) executeSkill resumes type, refreshes handles, and short-circuits a live-browser prepare", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "tool", "ui-run.ts")).text()
    const skillRegion = src.slice(src.indexOf("const executeSkill"), src.indexOf("for (let step = 0"))
    // (b) TOKEN FRESHNESS before token-using driver calls
    expect(skillRegion.includes("freshTarget")).toBe(true)
    expect(skillRegion.includes("refindElement(target")).toBe(true)
    // (a) resumable text delivery on the type sub-step
    expect(skillRegion.includes("runTypeDelivery(")).toBe(true)
    expect(skillRegion.includes('sub.kind === "type"')).toBe(true)
    // (c) a live-browser policy answer short-circuits (no retry) to the address-bar arm
    expect(skillRegion.includes("browserNeedsSetup(")).toBe(true)
  })
})

// GENERALIZATION — INVARIANT: prefer ONE atomic input event over N synthesized
// events when the surface accepts it. The address bar's clipboard paste is ONE
// input event; the live per-character type_text that landed only a prefix is the
// instance. An unseen surface that accepts a paste but drops keystrokes takes the
// SAME runner, with the bounded resumable type path as fallback only when the
// clipboard write did not land.
// hardcode-guard:allow the driver tool names + partial-delivery report are the wiring contract under test
describe("runUrlEntry — atomic paste with a bounded type fallback", () => {
  const win = { pid: 4242, window_id: 7 }
  const el = { element_token: "t1", role: "AXTextField", label: "Address and search bar" }
  const TEXT = "https://www.linkedin.com"

  test("(a) a written clipboard is delivered as ONE cmd+v paste, no per-character keys", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed({ ok: true, result: { content: [] } })
    }
    const run = await Effect.runPromise(runUrlEntry(call, win, el, TEXT, true))
    expect(run.mode).toBe("paste")
    expect(run.completed).toBe(true)
    expect(run.delivered).toBe(TEXT.length)
    expect(run.rounds).toBe(0)
    // ONE atomic input event: a single hotkey call, never a per-character press
    expect(calls.map((c) => c.name)).toEqual(["cua-driver_hotkey"])
    expect(calls[0].args.keys).toEqual(["cmd", "v"])
    expect(calls.some((c) => c.name === "cua-driver_type_text")).toBe(false)
  })

  test("(b) a failed clipboard write falls back to the bounded resumable type path", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed({ ok: true, result: { content: [] } })
    }
    const run = await Effect.runPromise(runUrlEntry(call, win, el, TEXT, false))
    expect(run.mode).toBe("type")
    expect(run.completed).toBe(true)
    expect(calls.some((c) => c.name === "cua-driver_hotkey")).toBe(false)
    expect(calls.map((c) => c.name)).toEqual(["cua-driver_type_text"])
  })

  test("(b) the fallback stays bounded when the type path never completes", async () => {
    const call: DriverCall = () =>
      Effect.succeed({ ok: false, error: "delivered 1 of 24 character(s); retry the remaining suffix" })
    const run = await Effect.runPromise(runUrlEntry(call, win, el, TEXT, false))
    expect(run.mode).toBe("type")
    expect(run.completed).toBe(false)
    expect(run.rounds).toBe(3)
    expect(run.failure).toBeDefined()
  })

  test("(a) hotkeyArgs emits a window-scoped chord for the atomic paste", () => {
    const args = hotkeyArgs(win, ["cmd", "v"])
    expect(args).toEqual({ pid: win.pid, window_id: win.window_id, keys: ["cmd", "v"] })
  })
})

describe("executeSkill — clipboard paste wiring", () => {
  test("(a) the route writes the clipboard, pastes once, value-gates before Return, and never reads the clipboard", async () => {
    const dir = path.join(import.meta.dir, "..", "..", "src", "tool")
    const src = await Bun.file(path.join(dir, "ui-run.ts")).text()
    const skillRegion = src.slice(src.indexOf("const executeSkill"), src.indexOf("for (let step = 0"))
    expect(skillRegion.includes('sub.kind === "clipboard"')).toBe(true)
    expect(skillRegion.includes('sub.kind === "paste"')).toBe(true)
    expect(skillRegion.includes('sub.kind === "verifyValue"')).toBe(true)
    expect(skillRegion.includes("cua-driver_clipboard_write")).toBe(true)
    expect(skillRegion.includes("runUrlEntry(")).toBe(true)
    // hardcode-guard:allow the atomic-paste driver tool name is the wiring contract under test
    // the paste chord lives in the shared runner this sub-step calls
    expect(src.includes("cua-driver_hotkey")).toBe(true)
    // (b) the paste sub-step can fall back to the bounded resumable type path
    expect(skillRegion.includes("runTypeDelivery(")).toBe(true)
    // (c) the value gate aborts before Return on a mismatch
    expect(skillRegion.includes("valueMatches(fieldValue(")).toBe(true)
    // (a) privacy: no route ever READS the clipboard
    for (const file of ["ui-run.ts", "ui-skills.ts", "ui-hands.ts"]) {
      expect((await Bun.file(path.join(dir, file)).text()).includes("clipboard_read")).toBe(false)
    }
    expect(CLIPBOARD_REPLACED_NOTE).toContain("clipboard")
  })
})

// GENERALIZATION — INVARIANT: a repeated DELIBERATE maneuver is not progress even
// when the screen changes. The live go_to_url re-issued 3-4× because a same-host
// redirect kept changing the screen (resetting the no-op bound) is ONE instance.
// An unseen case it covers: any maneuver (dismiss/scroll/search) that keeps
// "succeeding" without resolving — the SAME bound stops it, no loop change.
// hardcode-guard:allow the maneuver vocabulary is the loop's own contract under test
describe("maneuver-repeat bound", () => {
  test("(b) MAX_MANEUVER_REPEATS + 1 identical issues run; the next is refused, not a fourth", () => {
    const key = "go_to_url\u0000https://www.linkedin.com/messaging/"
    let state = initialManeuverRepeat()
    const runs: number[] = []
    const exceeded: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const step = maneuverRepeatStep(state, key)
      state = step.next
      runs.push(step.runs)
      exceeded.push(step.exceeded)
    }
    expect(runs.slice(0, 3)).toEqual([1, 2, 3])
    expect(exceeded.slice(0, 3)).toEqual([false, false, false])
    expect(exceeded[3]).toBe(true)
    expect(MAX_MANEUVER_REPEATS).toBe(2)
  })

  test("(b) a DIFFERENT maneuver resets the count", () => {
    const a = "go_to_url\u0000https://a.test/"
    const b = "dismiss_dialog\u0000"
    let state = initialManeuverRepeat()
    state = maneuverRepeatStep(state, a).next
    state = maneuverRepeatStep(state, a).next
    const switched = maneuverRepeatStep(state, b)
    expect(switched.runs).toBe(1)
    expect(switched.exceeded).toBe(false)
  })

  test("(b) the loop stops with maneuver-repeat-limit and records the chain", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "tool", "ui-run.ts")).text()
    expect(src.includes("maneuverRepeatStep(")).toBe(true)
    expect(src.includes('"maneuver-repeat-limit"')).toBe(true)
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

// GENERALIZATION — INVARIANT: ui_run is PLAN-DRIVEN — it commits a plan, offers
// ONLY maneuver options to jev (never raw control ids), executes the chosen
// maneuver through the executor, and terminates on a predicate PROVED OVER THE
// SCENE (never jev's say-so). Live instances: checkboxes clicked / the flat
// aimless frontier; unseen case: any scene whose goal-relevant region differs
// from chrome takes the same region-scoped predicates, no loop change.
// hardcode-guard:allow the synthetic list/login scenes are the general plan-loop shapes under test
describe("ui_run — plan loop (plan-driven execution over one executor)", () => {
  const el = (label: string, role = "AXLink"): Element => ({ element_token: label, role, label })
  const row = (label: string): SceneItem => ({
    id: label,
    role: "AXLink",
    label,
    affordances: ["activatable"],
    stateChanging: false,
    enabled: true,
    element: el(label),
  })
  const listScene = (labels: readonly string[], snapshot: string, extra: readonly SceneRegion[] = []): Scene => ({
    snapshot,
    regions: [{ id: `${snapshot}:list`, kind: "list", itemIds: labels.map((label) => label), textIds: [] }, ...extra],
    items: labels.map(row),
    texts: [],
  })

  const base = (over: Partial<PlanLoopDeps>): PlanLoopDeps => ({
    goal: "read the last 3 messages",
    observe: () => Effect.succeed(listScene(["m1", "m2", "m3"], "s-satisfied")),
    choosePlan: () => Effect.succeed(undefined),
    chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
    execute: () => Effect.succeed({ deliveryModes: [] }),
    stateChanging: () => false,
    readOnly: true,
    maxSteps: 8,
    ...over,
  })

  test("(a) commits a plan, offers ONLY maneuver options, executes them, terminates on read_count", async () => {
    const scenes = [listScene(["m1"], "s-partial"), listScene(["m1", "m2", "m3"], "s-satisfied")]
    let observed = scenes[0]
    let executed: ManeuverOption | undefined
    const offered: string[] = []
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => Effect.succeed(observed),
          chooseManeuver: (_subgoal, options) => {
            offered.push(...options.map((option) => option.label))
            return Effect.succeed({ label: options[0]?.label })
          },
          execute: (option) => {
            executed = option
            observed = scenes[1]
            return Effect.succeed({ deliveryModes: ["read"] })
          },
        }),
      ),
    )
    // the chosen maneuver came from the maneuver option space — never a raw control id
    expect(executed?.name).toBe("read_items")
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.every((label) => /^(read_items|open_item|activate|go_to_url|scroll_to|dismiss|back)\b/.test(label))).toBe(
      true,
    )
    // termination is the read_count predicate PROVED over the Scene, not jev's say-so
    expect(result.status).toBe("completed")
    expect(result.reason).toBe("predicate-satisfied")
    expect(result.progress?.done).toBe(3)
    expect(result.telemetry).toHaveLength(1)
    expect(result.telemetry[0].maneuver).toBe("read_items")
    expect(result.telemetry[0].progress.done).toBe(3)
  })

  test("(b) a state-changing maneuver below the gate NEVER executes — the run stops with the distinct status", async () => {
    let executed = false
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => Effect.succeed(listScene(["m1"], "s-partial")),
          chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label, strength: 0.4 }),
          execute: () => {
            executed = true
            return Effect.succeed({ deliveryModes: [] })
          },
          stateChanging: () => true,
          readOnly: false,
        }),
      ),
    )
    expect(result.status).toBe("below-gate")
    expect(executed).toBe(false)
    expect(result.frontier.length).toBeGreaterThan(0)
  })

  test("(b) a read-only goal with only a state-changing candidate stops read-only-blocked", async () => {
    let executed = false
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => Effect.succeed(listScene(["m1"], "s-partial")),
          chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label, strength: 0.99 }),
          execute: () => {
            executed = true
            return Effect.succeed({ deliveryModes: [] })
          },
          stateChanging: () => true,
          readOnly: true,
        }),
      ),
    )
    expect(result.status).toBe("read-only-blocked")
    expect(executed).toBe(false)
  })

  test("(b) at the gate a state-changing maneuver does execute", async () => {
    let executed = false
    const partial = listScene(["m1"], "s-partial")
    const satisfied = listScene(["m1", "m2", "m3"], "s-satisfied")
    let observed = partial
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => Effect.succeed(observed),
          chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label, strength: GATE_FLOOR }),
          execute: () => {
            executed = true
            observed = satisfied
            return Effect.succeed({ deliveryModes: [] })
          },
          stateChanging: () => true,
          readOnly: false,
        }),
      ),
    )
    expect(executed).toBe(true)
    expect(result.status).toBe("completed")
  })

  test("(a) a destructive maneuver ABOVE the gate stops for consent — distinct status, option + strength, executes nothing", async () => {
    let executed = false
    const scene = listScene(["Delete account"], "s-partial")
    const result = await Effect.runPromise(
      planLoop(
        base({
          goal: "read the last 3 messages",
          observe: () => Effect.succeed(scene),
          chooseManeuver: (_subgoal, options) => {
            const open = options.find((option) => option.name === "open_item")
            return Effect.succeed({ label: open?.label, strength: 0.99 })
          },
          execute: () => {
            executed = true
            return Effect.succeed({ deliveryModes: [] })
          },
          stateChanging: (option) => option.name === "open_item",
          readOnly: false,
        }),
      ),
    )
    // above the gate (0.99 > GATE_FLOOR) yet nothing executes: the distinct status
    expect(result.status).toBe("destructive-consent-required")
    expect(executed).toBe(false)
    expect(result.telemetry).toHaveLength(0)
    // the blocking option and its measured strength are reported for consent
    expect(result.consent?.option).toContain("open_item")
    expect(result.consent?.target).toBe("Delete account")
    expect(result.consent?.strength).toBe(0.99)
    expect(result.reason).toContain("Delete account")
  })

  test("(b) a NON-destructive state-changing maneuver ABOVE the gate still executes (no over-blocking)", async () => {
    let executed = false
    const partial = listScene(["Inbox"], "s-partial")
    const satisfied = listScene(["Inbox", "m2", "m3"], "s-satisfied")
    let observed = partial
    const result = await Effect.runPromise(
      planLoop(
        base({
          goal: "read the last 3 messages",
          observe: () => Effect.succeed(observed),
          chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label, strength: 0.99 }),
          execute: () => {
            executed = true
            observed = satisfied
            return Effect.succeed({ deliveryModes: [] })
          },
          stateChanging: () => true,
          readOnly: false,
        }),
      ),
    )
    expect(executed).toBe(true)
    expect(result.status).toBe("completed")
    expect(result.consent).toBeUndefined()
  })

  test("(e) the boundary generalises: an activating maneuver over an unseen irreversible label stops, a read over it does not", () => {
    const scene: Scene = { snapshot: "s", regions: [], items: [row("Unsubscribe"), row("Details")], texts: [] }
    const option = (name: string, target: SceneItem): ManeuverOption => ({
      name,
      label: `${name}: x`,
      targets: [{ kind: "item", id: target.id, role: target.role, label: target.label }],
      preconditions: [],
      success: { predicate: "screenChanged", detail: "" },
      inputs: [],
    })
    const unsubscribe = row("Unsubscribe")
    const details = row("Details")
    // unseen irreversible affordance under an ACTIVATING maneuver → blocked
    expect(isDestructive("Unsubscribe")).toBe(true)
    expect(destructiveManeuver(option("open_item", unsubscribe), scene)).toBe(true)
    // the SAME destructive target under a READ maneuver is inert — reads are never blocked
    expect(destructiveManeuver(option("read_items", unsubscribe), scene)).toBe(false)
    // a non-destructive activating maneuver is not blocked
    expect(destructiveManeuver(option("open_item", details), scene)).toBe(false)
  })

  test("(c) a login/credential wall stops the run with its reason, typing nothing", async () => {
    let executed = false
    const scene: Scene = {
      snapshot: "s-login",
      regions: [],
      items: [],
      texts: [
        { id: "pw", role: "AXSecureTextField", text: "Password", owner: "scene", element: el("Password", "AXSecureTextField") },
      ],
    }
    expect(loginWall(scene)).toContain("credential")
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => Effect.succeed(scene),
          execute: () => {
            executed = true
            return Effect.succeed({ deliveryModes: [] })
          },
        }),
      ),
    )
    expect(result.status).toBe("login-wall")
    expect(result.reason).toContain("credential")
    expect(executed).toBe(false)
  })

  test("(d) oscillation drives a bounded replan to a distinct stop reason", async () => {
    const toolbar = (snapshot: string): SceneRegion => ({ id: `${snapshot}:toolbar`, kind: "toolbar", itemIds: [], textIds: [] })
    const a = listScene(["m1"], "s-a", [toolbar("s-a")])
    const b = listScene(["m1"], "s-b", [toolbar("s-b")])
    const views = [a, b]
    let index = 0
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => Effect.succeed(views[index % 2]),
          chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
          execute: () => {
            index++
            return Effect.succeed({ deliveryModes: [] })
          },
          stateChanging: () => false,
          readOnly: true,
          maxSteps: 12,
        }),
      ),
    )
    // bounded replan: the run never reports the goal completed and stops on a
    // distinct no-progress reason, not on jev's say-so.
    expect(result.status).not.toBe("completed")
    expect(["scene-oscillation", "maneuver-repeat-limit", "no-maneuver"]).toContain(result.status)
    expect(result.telemetry.length).toBeGreaterThan(0)
  })

  // hardcode-guard:allow fixture labels/tokens are the enumerable input under test
  test("(d) oscillation drives the REPLAN bound to a scene-oscillation stop, never the repeat bound", async () => {
    // The two views differ in a TEXT (not the list), so the scene diff sees an A↔B
    // oscillation while read_count makes no predicate progress.
    const view = (snapshot: string, text: string): Scene => ({
      snapshot,
      regions: [{ id: `${snapshot}:list`, kind: "list", itemIds: ["m1"], textIds: [] }],
      items: [row("m1")],
      texts: [{ id: "body", role: "AXStaticText", text, owner: "scene", element: el(text) }],
    })
    const views: Scene[] = [view("s-a", "alpha"), view("s-b", "beta")]
    let index = 0
    let picks = 0
    const offered = new Set<string>()
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => Effect.succeed(views[index % 2]),
          // rotate through the distinct maneuver NAMES so the identical-maneuver
          // repeat bound can never fire — the only bound left is the replan bound.
          chooseManeuver: (_subgoal, options) => {
            for (const option of options) offered.add(option.name)
            return Effect.succeed({ label: options[picks++ % options.length]?.label })
          },
          execute: () => {
            index++
            return Effect.succeed({ deliveryModes: [] })
          },
          stateChanging: () => false,
          readOnly: true,
          maxSteps: 12,
        }),
      ),
    )
    expect(result.status).toBe("scene-oscillation")
    expect(result.reason).toBe("scene-oscillation")
    expect(result.telemetry.length).toBeGreaterThan(0)
    // more than one maneuver name was offered, so the stop is the replan bound.
    expect(offered.size).toBeGreaterThan(1)
  })

  // hardcode-guard:allow the empty scene is the unadvanceable shape under test
  test("(d) a subgoal whose option space is empty stops with the distinct no-maneuver status + reason", async () => {
    const empty: Scene = { snapshot: "s-empty", regions: [], items: [], texts: [] }
    const result = await Effect.runPromise(planLoop(base({ observe: () => Effect.succeed(empty) })))
    expect(result.status).toBe("no-maneuver")
    expect(result.reason).toContain("no maneuver can advance subgoal")
    expect(result.telemetry).toHaveLength(0)
  })
})

// GENERALIZATION — the invariant: the run's returned metadata carries the plan
// telemetry (every decision and its evidence), and MINING runs over that plan
// trace, never the empty flat-loop trace; repetition is flagged, never
// self-promoted into the registry.
// hardcode-guard:allow fixture labels/tokens are the enumerable input under test
describe("ui_run — plan telemetry in the returned summary, and mining over it", () => {
  const step = (over: Partial<PlanLoopTelemetry> & { subgoalIndex: number; maneuver: string }): PlanLoopTelemetry => ({
    planId: "read-here",
    label: `${over.maneuver}: a maneuver`,
    deliveryModes: ["read"],
    progress: { done: 1, total: 3, reasons: [] },
    reason: "executed",
    ...over,
  })

  test("(a) the returned summary carries the plan id, per-step telemetry and candidates", () => {
    const telemetry: PlanLoopTelemetry[] = [
      step({
        subgoalIndex: 0,
        maneuver: "read_items",
        label: "read_items: read up to 3 list item(s)",
        strength: 0.91,
        progress: { done: 3, total: 3, reasons: ["predicate-satisfied"] },
      }),
    ]
    const summary = planSummary({
      status: "completed",
      reason: "predicate-satisfied",
      planId: "read-here",
      telemetry,
      progress: undefined,
      frontier: [],
    })
    expect(summary.planId).toBe("read-here")
    expect(summary.telemetry[0].subgoalIndex).toBe(0)
    expect(summary.telemetry[0].maneuver).toBe("read_items")
    expect(summary.telemetry[0].strength).toBe(0.91)
    expect(summary.telemetry[0].deliveryModes).toEqual(["read"])
    expect(summary.telemetry[0].progress).toEqual({ done: 3, total: 3, reasons: ["predicate-satisfied"] })
    expect(summary.promotionCandidates).toEqual([])
  })

  test("(b) repeated delivered plan maneuvers emit a promotion candidate from the plan telemetry", () => {
    const candidates = minePlan([
      step({ subgoalIndex: 0, maneuver: "read_items" }),
      step({ subgoalIndex: 1, maneuver: "open_item" }),
      step({ subgoalIndex: 2, maneuver: "read_items" }),
      step({ subgoalIndex: 3, maneuver: "open_item" }),
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].occurrences).toBe(2)
    expect(candidates[0].sequence).toEqual(["read_items read_items: a maneuver", "open_item open_item: a maneuver"])
  })

  test("(b) a clean plan trace (no repetition / nothing delivered) emits no candidate", () => {
    expect(
      minePlan([step({ subgoalIndex: 0, maneuver: "read_items" }), step({ subgoalIndex: 1, maneuver: "open_item" })]),
    ).toEqual([])
    expect(
      minePlan([
        step({ subgoalIndex: 0, maneuver: "read_items", reason: "failed: click undelivered" }),
        step({ subgoalIndex: 1, maneuver: "read_items", reason: "failed: click undelivered" }),
        step({ subgoalIndex: 2, maneuver: "read_items", reason: "failed: click undelivered" }),
        step({ subgoalIndex: 3, maneuver: "read_items", reason: "failed: click undelivered" }),
      ]),
    ).toEqual([])
  })
})
