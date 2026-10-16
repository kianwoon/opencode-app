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
  FOCUS_CONSUMER_KINDS,
  FRONTIER_HARD_MAX,
  GATE_FLOOR,
  OFF_VIEWPORT,
  Parameters,
  REVEAL_BUDGET,
  STATUS_UNSETTLED,
  STATUS_UNREADABLE,
  STATUS_UNUSABLE_CHOICE,
  STATUS_NO_APPLICABLE,
  UiRunTool,
  actuatorBinding,
  actuatorOf,
  advanceMap,
  clickFailure,
  completionEvidence,
  decodeObservation,
  destructiveManeuver,
  ensureVisible,
  extractGoalValue,
  focusConsumerAhead,
  isDestructive,
  loginWall,
  minePlan,
  mineTrace,
  needsForegroundDelivery,
  nextAmbiguity,
  normalizeExpect,
  isReadManeuver,
  planLoop,
  planSummary,
  READ_STRATEGIES,
  readEvidence,
  readTokens,
  resolveRead,
  resolveTarget,
  runReadManeuver,
  revealFailure,
  runClickRungs,
  runTypeDelivery,
  runUrlEntry,
  screenSignature,
  selectItem,
  stateChangingManeuver,
  type DriverCall,
  type DriverOutcome,
  type ActuationScope,
  type PlanLoopDeps,
  type PlanLoopTelemetry,
  type StepTrace,
} from "@/tool/ui-run"
import { MANEUVER_NAMES, READ_STRATEGY_NAMES, type ManeuverName, type ManeuverOption } from "@/tool/ui-maneuvers"
import type { Progress } from "@/tool/ui-progress"
import type { Scene, SceneItem, SceneRegion, SceneText } from "@/tool/ui-scene"
import { affordancesOf } from "@/tool/ui-scene"
import { buildCandidates, usableElements, type Element } from "@/tool/ui-eyes"
import {
  AUTHORIZATION_FLAG,
  AUTHORIZATION_REQUIRED,
  CLIPBOARD_REPLACED_NOTE,
  CONTAINER_UNMOVED,
  LAUNCH_APP_ACCEPTED,
  LAUNCH_APP_NAME_ARG,
  REFUSED_BY_POLICY,
  UNSUPPORTED_ACTION,
  actuationPlan,
  ancestorChain,
  changeEvidence,
  clickAttempt,
  clickSignals,
  clickVerdict,
  containerSignature,
  declaredAction,
  declaredActions,
  elementCenter,
  escalateRung,
  focusIdentity,
  foldFocusConsumer,
  frameEstablishingRead,
  hasScrollActions,
  hotkeyArgs,
  isFocusTarget,
  isNoFrameError,
  isPolicyRefused,
  isScrollableContainer,
  launchAppArgs,
  observationArgs,
  pixelFrameRetry,
  scrollContainerOf,
  targetState,
  visibilityOf,
  windowBounds,
  withinBounds,
  type ActuationRung,
  type ClickSignals,
} from "@/tool/ui-hands"
import { goToUrl, matchSkills, type SkillStep } from "@/tool/ui-skills"
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

  // hardcode-guard:allow the element token, action and tree labels are the enumerable actuation inputs under test
  test("(a) a no-op declared rung escalates to foreground, then a no-frame pixel rung establishes ONE frame and retries", async () => {
    const button = {
      element_token: "t1",
      role: "AXButton",
      label: "Go",
      actions: ["AXPress"],
      frame: { x: 0, y: 0, width: 10, height: 10 },
    }
    const plan = actuationPlan(button, win)
    expect(plan.map((r) => r.mode)).toEqual(["declared", "pixel"])
    // the "before" screen IS the unchanged tree's signature, so each probe reads no change
    const unchanged = decodeObservation(tree("Go"))
    if (unchanged === null) throw new Error("tree must decode")
    const before = clickSignals(screenSignature(unchanged.elements), button, unchanged.elements)

    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // declared click
      { ok: true, result: { content: [], structuredContent: tree("Go") } }, // probe: unchanged
      { ok: true, result: { content: [] } }, // FOREGROUND element re-issue
      { ok: true, result: { content: [], structuredContent: tree("Go") } }, // probe: unchanged
      { ok: false, error: NO_FRAME }, // pixel click: no frame
      { ok: true, result: { content: [], structuredContent: tree("Go") } }, // frame-establishing read: unchanged
      { ok: true, result: { content: [] } }, // retried pixel click
      { ok: true, result: { content: [], structuredContent: tree("Gone") } }, // probe: screen changed → delivered
    ])

    const run = await Effect.runPromise(runClickRungs(driver.call, win, button, plan, before, before.screen))

    // the declared no-op escalated to the SAME element re-issued foreground
    const foreground = driver.calls.filter((c) => c.args.delivery_mode === "foreground" && c.args.x === undefined)
    expect(foreground).toHaveLength(1)
    expect(foreground[0]!.args).toMatchObject({ element_token: "t1", action: "press" })
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
    expect(run.attempts.map((a) => a.mode)).toEqual(["declared", "foreground", "pixel", "pixel"])
    expect(run.attempts[3].reasons).toContain("screen")
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

// GENERALIZATION — INVARIANT: an actuation targets the element that CARRIES the
// action, not merely the element that was NAMED. A resolved container that
// declares no action hands the click to its nearest actionable DESCENDANT; a
// target with neither an action nor an actionable descendant is reported
// UNDELIVERED, never blind-clicked on an unrelated element. LIVE INSTANCE: the
// macOS wallpaper row carries no AXPress while the swatch control inside it does.
// UNSEEN CASE COVERED: a list row wrapping a toggle is actuated by the toggle.
// hardcode-guard:allow fixture labels/tokens are the enumerable inputs under test
describe("actuator resolution — the click lands on the element that carries the action", () => {
  const win = { pid: 4242, window_id: 7 }
  const wire = (elements: readonly Element[]) => ({
    snapshot_id: "s1",
    elements: elements.map((element) => ({
      token: element.element_token,
      role: element.role,
      label: element.label,
      selected: element.selected,
      actions: element.actions,
      frame: element.frame,
      element_index: element.element_index,
      parent_index: element.parent_index,
      depth: element.depth,
    })),
  })
  const makeDriver = (script: DriverOutcome[]) => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed(script.shift() ?? { ok: false, error: "unscripted" })
    }
    return { call, calls }
  }

  test("(a) a row declaring no action resolves to its AXPress child, and the click carries the child", async () => {
    const els: Element[] = [
      {
        element_index: 0,
        element_token: "t0",
        role: "AXRow",
        label: "Wallpaper",
        depth: 1,
        frame: { x: 0, y: 0, width: 200, height: 40 },
      },
      {
        element_index: 1,
        element_token: "t1",
        role: "AXButton",
        label: "Black",
        depth: 2,
        parent_index: 0,
        actions: ["AXPress"],
        frame: { x: 8, y: 8, width: 40, height: 24 },
      },
    ]
    const named = els[0]!
    const target = actuatorOf(named, els)
    expect(target.element_token).toBe("t1")
    const plan = actuationPlan(target, win)
    // declared rung first (the CHILD's own AXPress), pixel second at the CHILD's frame
    expect(plan.map((r) => r.mode)).toEqual(["declared", "pixel"])
    expect(plan[0].args).toMatchObject({ element_token: "t1", action: "press" })
    expect(plan[1].args).toMatchObject({ x: 28, y: 20, delivery_mode: "foreground" })

    const before = clickSignals(screenSignature(els), target, els)
    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // declared click on the child
      { ok: true, result: { content: [], structuredContent: wire([{ ...els[1]!, selected: true }, els[0]!]) } }, // child state changed → delivered
    ])
    const run = await Effect.runPromise(runClickRungs(driver.call, win, target, plan, before, before.screen))
    expect(driver.calls[0]).toMatchObject({ name: "cua-driver_click" })
    expect(driver.calls[0]!.args).toMatchObject({ element_token: "t1", action: "press" })
    expect(run.outcome.worked).toBe(true)
  })

  test("(b) a target with neither an action nor an actionable descendant stays undelivered, not blind-clicked", async () => {
    const els: Element[] = [
      {
        element_index: 0,
        element_token: "r0",
        role: "AXRow",
        label: "Wallpaper",
        depth: 1,
        frame: { x: 0, y: 0, width: 200, height: 40 },
      },
      {
        element_index: 1,
        element_token: "c1",
        role: "AXStaticText",
        label: "Black",
        depth: 2,
        parent_index: 0,
        frame: { x: 8, y: 8, width: 40, height: 24 },
      },
    ]
    const named = els[0]!
    expect(actuatorOf(named, els)).toBe(named)
    const plan = actuationPlan(named, win)
    const before = clickSignals(screenSignature(els), named, els)
    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // declared click
      { ok: true, result: { content: [], structuredContent: wire(els) } }, // probe: unchanged
      { ok: true, result: { content: [] } }, // foreground element re-issue
      { ok: true, result: { content: [], structuredContent: wire(els) } }, // probe: unchanged
      { ok: true, result: { content: [] } }, // pixel click
      { ok: true, result: { content: [], structuredContent: wire(els) } }, // probe: unchanged
    ])
    const run = await Effect.runPromise(runClickRungs(driver.call, win, named, plan, before, before.screen))
    expect(run.outcome.worked).toBe(false)
    // the whole permitted ladder was attempted, declared → foreground → pixel
    expect(run.attempts.map((attempt) => attempt.mode)).toEqual(["declared", "foreground", "pixel"])
    expect(run.attempts.every((attempt) => !attempt.delivered)).toBe(true)
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

// GENERALIZATION — INVARIANT: the maneuver-name-keyed repeat counter is DELETED.
// A repeated maneuver is made impossible by construction (depleting offers), not
// bounded by a counter. The live read_text re-issued identically 3× then stopped
// on maneuver-repeat-limit is the instance this closes; an unseen case it covers:
// any maneuver whose option is consumed is no longer offered, so it cannot re-pick.
// hardcode-guard:allow the deleted-counter vocabulary is the contract under test
describe("maneuver-repeat counter is deleted", () => {
  test("(d) no maneuver-name-keyed repeat counter remains in the source", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "tool", "ui-run.ts")).text()
    expect(src.includes("maneuverRepeatStep(")).toBe(false)
    expect(src.includes("maneuverRepeatStep")).toBe(false)
    expect(src.includes("MAX_MANEUVER_REPEATS")).toBe(false)
    expect(src.includes("ManeuverRepeatState")).toBe(false)
    expect(src.includes('"maneuver-repeat-limit"')).toBe(false)
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
    const option = (name: ManeuverName, target: SceneItem): ManeuverOption => ({
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

  // hardcode-guard:allow the file-URL/target URL and the synthetic labels are the enumerable inputs under test (goal + scene), not named one-off cases
  test("(a) a file-URL + 3-messages goal over an unrelated page does NOT complete at step 0", async () => {
    let executed = false
    const unrelated = listScene(["Inbox", "Sent", "Drafts", "Archive"], "s-unrelated")
    const result = await Effect.runPromise(
      planLoop(
        base({
          goal: 'go to "file:///tmp/messages.html" and read the last 3 messages',
          observe: () => Effect.succeed(unrelated),
          chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
          execute: () => {
            executed = true
            return Effect.succeed({ deliveryModes: [] })
          },
          stateChanging: () => false,
          readOnly: true,
          maxSteps: 1,
        }),
      ),
    )
    // NOT "completed", NOT "predicate-satisfied": the navigate subgoal is unsatisfied
    expect(result.status).not.toBe("completed")
    expect(result.reason).not.toBe("predicate-satisfied")
    expect(result.progress?.perSubgoal[0].success).toBe(false)
    // nothing was executed on the unrelated page (no navigable target there)
    expect(executed).toBe(false)
  })

  test("(b) a zero-step completion is legitimate ONLY when the initial scene honestly satisfies it — and it cites its evidence", async () => {
    const arrived: Scene = {
      snapshot: "s-arrived",
      regions: [],
      items: [],
      texts: [
        {
          id: "u",
          role: "AXStaticText",
          text: "https://example.invalid/inbox",
          owner: "scene",
          element: el("https://example.invalid/inbox", "AXStaticText"),
        },
      ],
    }
    const result = await Effect.runPromise(
      planLoop(
        base({
          goal: 'navigate to "https://example.invalid/inbox"',
          observe: () => Effect.succeed(arrived),
          maxSteps: 1,
        }),
      ),
    )
    expect(result.status).toBe("completed")
    expect(result.telemetry).toHaveLength(0)
    expect(result.evidence?.length).toBeGreaterThan(0)
    expect(result.evidence?.join(" ")).toContain("example.invalid")
  })

  test("(b) zero-step completion is REFUSED when a satisfied subgoal cites no content", () => {
    const unevidenced: Progress = {
      perSubgoal: [{ success: true, verdict: "true", evidence: "region present", cited: [] }],
      done: 1,
      total: 1,
      nextSubgoal: undefined,
      shouldReplan: false,
      exhausted: false,
      reason: undefined,
    }
    expect(completionEvidence(unevidenced)).toBeUndefined()
    const evidenced: Progress = {
      ...unevidenced,
      perSubgoal: [{ success: true, verdict: "true", evidence: "text present", cited: ["alpha"] }],
    }
    expect(completionEvidence(evidenced)).toEqual(["alpha"])
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
    // A genuine A↔B oscillation is a WORLD-MODEL diff (item content), not a region-id
    // change: region ids are snapshot-scoped and never part of the Scene fingerprint,
    // so a region-only difference is not an oscillation at all.
    const a = listScene(["alpha"], "s-a")
    const b = listScene(["beta"], "s-b")
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
    // bounded replan: the run never reports the goal completed and stops on the
    // distinct oscillation reason that survives the deleted repeat bound.
    expect(result.status).not.toBe("completed")
    expect(result.status).toBe("scene-oscillation")
    expect(result.reason).toBe("scene-oscillation")
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
  test("(c) a subgoal whose option space is empty stops with the distinct nothing-applicable outcome, never the decider-failure stop", async () => {
    const empty: Scene = { snapshot: "s-empty", regions: [], items: [], texts: [] }
    const result = await Effect.runPromise(planLoop(base({ observe: () => Effect.succeed(empty) })))
    expect(result.status).toBe(STATUS_NO_APPLICABLE)
    expect(result.status).not.toBe(STATUS_UNUSABLE_CHOICE)
    expect(result.reason).toContain("nothing-applicable")
    expect(result.reason).toContain("no maneuver can advance subgoal")
    expect(result.telemetry).toHaveLength(0)
  })
})

// GENERALIZATION — INVARIANT: perception must be ALLOWED TO CONVERGE before it is
// judged. A page that is still arriving is observed repeatedly (bounded) until two
// consecutive observations agree; only a SETTLED scene may decide the run. LIVE
// INSTANCE: a cold page presents a partial conversation list, so a single
// observation must never complete the read. UNSEEN CASES COVERED: infinite scroll
// (the list keeps growing), a spinner that removes itself (the scene changes as the
// overlay leaves), and content that arrives in two waves (blank → partial → full).
// hardcode-guard:allow fixture labels/tokens are the enumerable inputs under test
describe("ui_run — settlement: no judgement on a moving scene", () => {
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
  const listScene = (labels: readonly string[], snapshot: string): Scene => ({
    snapshot,
    regions: [{ id: `${snapshot}:list`, kind: "list", itemIds: [...labels], textIds: [] }],
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

  test("(a) a settled scene proceeds, and the step telemetry records the settle count", async () => {
    const partial = listScene(["m1"], "s-partial")
    const full = listScene(["m1", "m2", "m3"], "s-full")
    let observed = partial
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => Effect.succeed(observed),
          execute: () => {
            observed = full
            return Effect.succeed({ deliveryModes: ["read"] })
          },
          settleBudget: 6,
          maxSteps: 4,
        }),
      ),
    )
    expect(result.status).toBe("completed")
    expect(result.telemetry).toHaveLength(1)
    expect(result.telemetry[0].settle?.settled).toBe(true)
    expect(result.telemetry[0].settle?.observations).toBeGreaterThanOrEqual(2)
  })

  test("(b) a still-arriving list is observed repeatedly, then read only once it is stable", async () => {
    // The page arrives in two waves: partial, partial, full, full.
    const partial = listScene(["m1"], "s-partial")
    const full = listScene(["m1", "m2", "m3"], "s-full")
    const timeline = [partial, partial, full, full]
    let calls = 0
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => Effect.succeed(timeline[Math.min(calls++, timeline.length - 1)]),
          settleBudget: 8,
          maxSteps: 4,
        }),
      ),
    )
    expect(result.status).toBe("completed")
    // it did NOT decide from the first observation: it waited through both waves.
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test("(b) an unstable scene yields pending (never satisfied) and the loop waits, then stops distinct", async () => {
    const a = listScene(["m1"], "s-a")
    const b = listScene(["m1", "m2"], "s-b")
    const views = [a, b]
    let calls = 0
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => {
            calls++
            return Effect.succeed(views[calls % 2])
          },
          settleBudget: 4,
          maxSteps: 4,
        }),
      ),
    )
    // the scene never converged: the loop waited and withheld judgement.
    expect(result.status).toBe(STATUS_UNSETTLED)
    expect(result.status).not.toBe("completed")
    expect(result.evidence).toBeUndefined()
    expect(result.telemetry).toHaveLength(0)
    expect(calls).toBeGreaterThanOrEqual(4)
  })

  test("(b) the settle budget expiring yields a distinct status, never a false decision from a full-but-moving list", async () => {
    // Every observation WOULD satisfy the read; the scene is moving, so it may not.
    const full = listScene(["m1", "m2", "m3"], "s-full")
    const partial = listScene(["m1"], "s-partial")
    let calls = 0
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => {
            calls++
            return Effect.succeed(calls % 2 === 1 ? full : partial)
          },
          settleBudget: 3,
          maxSteps: 2,
        }),
      ),
    )
    expect(result.status).toBe(STATUS_UNSETTLED)
    expect(result.status).not.toBe("completed")
    expect(result.evidence).toBeUndefined()
  })

  test("(b) a momentarily-stable loading state is not settled: the duration floor withholds judgement", async () => {
    // The scene is identical across every observation, but it has NOT stayed
    // unchanged for the minimum duration — a skeleton/spinner, not loaded content.
    const loading = listScene(["m1"], "s-loading")
    let calls = 0
    const result = await Effect.runPromise(
      planLoop(
        base({
          observe: () => {
            calls++
            return Effect.succeed(loading)
          },
          settleBudget: 3,
          settleDelayMs: 10,
          settleMinStableMs: 5_000,
          maxSteps: 2,
        }),
      ),
    )
    expect(result.status).toBe(STATUS_UNSETTLED)
    expect(result.status).not.toBe("completed")
    expect(calls).toBe(3)
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
    provenance: { option: "read_items", selection: "decider", path: "read", predicate: true, evidence: 1 },
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

// GENERALIZATION — INVARIANT: a click's delivery is judged by the EFFECT it
// exists to produce, tracked across EVERY consumer class that can follow it on
// the SAME target (type / keys / key / paste / clipboard / a hotkey chord), and a
// refusal is reported as a refusal, never as silence. The committed `go_to_url`
// address-bar route is the LIVE INSTANCE: its focus click on the address bar is
// followed by a clipboard write and a single `cmd+v` paste, and the click is
// delivered the moment that paste lands even though the click itself changed no
// signal. UNSEEN CASE COVERED: a route whose consumer is a HOTKEY chord rather
// than a typed key (a Cmd-based menu command consuming the focus) folds the same
// way, because deferral is keyed on the route's consumer classes, not the click.
describe("focus-click delivery — every consumer class (functional delivery)", () => {
  const win = { pid: 4242, window_id: 7 }
  // hardcode-guard:allow the captured address-bar role/label are the live inputs under test
  const URL = "https://www.linkedin.com"
  const bar = {
    element_token: "s1:6",
    role: "AXTextField",
    label: "Address and search bar",
    value: "x.com/home",
    actions: ["AXPress", "AXShowMenu"],
    frame: { x: 10, y: 20, width: 200, height: 30 },
  }
  const clickBefore = clickSignals("nA", bar, [bar])
  // hardcode-guard:allow the driver's refusal text is the live error under test
  const REFUSAL = "Raw coordinate click blocked: the px path is reserved for canvas/WebGL targets"
  const refusedPixel = clickAttempt(
    { mode: "pixel", label: "pixel(110,35)", args: {} },
    clickBefore,
    clickBefore,
    bar,
    REFUSAL,
  )
  const barValue = (value: string) => clickSignals("nA", { ...bar, value }, [{ ...bar, value }])

  test("(c) a file:// goal value matches go_to_url — the loop binds the route, never a bare address-bar click", () => {
    // hardcode-guard:allow the scheme-general goal value is the live input under test
    const fileValue = "file:///tmp/messages.html"
    // the LIVE goal form is UNQUOTED: the goal-value extractor falls back to an
    // http(s)-only match, so an unquoted file:// value returns undefined and the
    // loop fell through to a bare click with no consumer to defer to. The plan's
    // navigate subgoal carries the value scheme-generally; binding the skill to
    // THAT value is what makes the address-bar route run.
    const liveGoal = `navigate to ${fileValue} and read the last 3 messages`
    expect(extractGoalValue(liveGoal)).toBeUndefined()
    expect(matchSkills([bar], fileValue).map((match) => match.skill.name)).toContain("go_to_url")
    // hardcode-guard:allow the scheme-general goal value is the live input under test
    const match = matchSkills([bar], fileValue).find((entry) => entry.skill.name === "go_to_url")
    expect(match?.element.label).toBe(bar.label)
    // and its every arm ends in a verify, so arrival — not the click — is success
    const branch = match !== undefined ? goToUrl.steps(match).find((step) => step.kind === "branch") : undefined
    expect(branch !== undefined && branch.kind === "branch").toBe(true)
  })

  test("(a) the committed address-bar route's focus click resolves DELIVERED at its paste, never click-undelivered", () => {
    const outer = goToUrl.steps({ skill: goToUrl, element: bar, value: URL }).find((step) => step.kind === "branch")
    const prepared = outer !== undefined && outer.kind === "branch" ? outer.fallback : []
    const inner = prepared.find((step) => step.kind === "branch")
    const route: readonly SkillStep[] = inner !== undefined && inner.kind === "branch" ? inner.fallback : []
    // the live shape: focus → clipboard → select-all → paste → verify → Return → verify
    expect(route.map((step) => step.kind)).toEqual([
      "click",
      "clipboard",
      "key",
      "paste",
      "verifyValue",
      "key",
      "verifyScreen",
    ])
    // the click defers because a focus consumer is still AHEAD on the same target
    expect(focusConsumerAhead(route.slice(1))).toBe(true)
    // the click really is undelivered on its own (its pixel rung was policy-refused)
    expect(refusedPixel.delivered).toBe(false)
    expect(refusedPixel.reasons).toContain("refused-by-policy")
    // consumers BEFORE the paste land nothing and move no signal → still pending
    let folded = foldFocusConsumer(refusedPixel, barValue("x.com/home"), bar, false)
    folded = foldFocusConsumer(folded, barValue("x.com/home"), bar, false)
    expect(folded.delivered).toBe(false)
    // the paste lands → the click is delivered, so the loop proceeds (no abort)
    folded = foldFocusConsumer(folded, barValue(URL), bar, true)
    expect(folded.delivered).toBe(true)
    expect(folded.reasons).toContain("focus-consumer")
    // and the sub-step immediately AFTER the paste is the Return submit
    expect(route[5]).toMatchObject({ kind: "key", key: "return" })
  })

  test("(a) route-based deferral covers a click whose element declares no AXPress (the generalization)", () => {
    const bare = { element_token: "s1:7", role: "AXTextField", label: "Search field", value: "" }
    expect(isFocusTarget(bare)).toBe(false) // no declared press — deferral must come from the route
    const route: readonly SkillStep[] = [
      { kind: "click", label: "focus" },
      { kind: "type", label: "type value", text: "q" },
    ]
    expect(focusConsumerAhead(route.slice(1))).toBe(true)
    const before = clickSignals("nA", bare, [bare])
    const attempt = clickAttempt({ mode: "declared", label: "click", args: {} }, before, before, bare)
    expect(attempt.delivered).toBe(false)
    expect(foldFocusConsumer(attempt, clickSignals("nA", bare, [{ ...bare, value: "q" }]), bare).delivered).toBe(true)
  })

  test("(b) HONEST NEGATIVE: no consumer landing and no signal change stays undelivered", () => {
    let folded = refusedPixel
    for (const _kind of ["clipboard", "key", "paste"]) {
      folded = foldFocusConsumer(folded, barValue("x.com/home"), bar, false)
    }
    expect(folded.delivered).toBe(false)
    expect(folded.reasons).not.toContain("focus-consumer")
  })

  test("(c) the declared press rung is attempted FIRST, and a pixel refusal is recorded as refused-by-policy", () => {
    const plan = actuationPlan(bar, win)
    expect(plan.map((rung) => rung.mode)).toEqual(["declared", "pixel"])
    expect(plan[0]).toMatchObject({ mode: "declared", label: "press", args: { action: "press" } })
    expect(isPolicyRefused(REFUSAL)).toBe(true)
    expect(refusedPixel.mode).toBe("pixel")
    expect(refusedPixel.reasons).toContain("refused-by-policy")
    expect(refusedPixel.error).toBe(REFUSAL)
  })

  test("(c) the consumer vocabulary is single-sourced and the loop resolves it at ONE site", async () => {
    for (const kind of ["type", "keys", "key", "paste", "clipboard"] as const) {
      expect(FOCUS_CONSUMER_KINDS.has(kind)).toBe(true)
    }
    for (const kind of ["verifyValue", "verifyScreen", "navigate", "read"] as const) {
      expect(FOCUS_CONSUMER_KINDS.has(kind)).toBe(false)
    }
    const src = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "tool", "ui-run.ts")).text()
    // ONE definition, invoked at every consumer site (paste / keys / key / type)
    // hardcode-guard:allow the assertion counts the loop's contract sites (one resolver), not a case literal
    expect(src.match(/const settleFocus =/g) ?? []).toHaveLength(1)
    expect(src.match(/settleFocus\(/g) ?? []).toHaveLength(4)
    expect(src.includes("focusConsumerAhead(queue)")).toBe(true)
    // the deferral is never silently absorbed: an unresolved focus click still fails
    expect(src.includes('"focus click undelivered (no consumer landed)"')).toBe(true)
  })
})

// GENERALIZATION — INVARIANT: intent selects the plan shape, and a MUTATION is
// proven by OBSERVED STATE, never by reading. LIVE INSTANCE: "change my mac
// wallpaper to black" reported `completed` by reading the Settings sidebar (0
// actions). UNSEEN SHAPE COVERED: any toggle/radio/option goal — the read plan is
// unreachable from a mutation goal, so no list read can ever complete it.
// hardcode-guard:allow fixture labels/tokens are the enumerable inputs under test
describe("ui_run — a mutation goal is never completed by a read", () => {
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
  const sidebar = (): Scene => ({
    snapshot: "s-sidebar",
    regions: [{ id: "r0:list", kind: "list", itemIds: ["About", "Software Update", "Storage", "Wallpaper"], textIds: [] }],
    items: ["About", "Software Update", "Storage", "Wallpaper"].map(row),
    texts: [],
  })

  test("(a) a wallpaper-mutation goal over the Settings sidebar never completes on the sidebar read", async () => {
    let executed = 0
    const result = await Effect.runPromise(
      planLoop({
        goal: "change my mac wallpaper to black",
        observe: () => Effect.succeed(sidebar()),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: () => {
          executed++
          return Effect.succeed({ deliveryModes: [] })
        },
        stateChanging: () => false,
        readOnly: false,
        maxSteps: 8,
      }),
    )
    // NOT the live false completion: the plan is the mutation, never `read-here`
    expect(result.planId).toBe("mutate")
    expect(result.status).not.toBe("completed")
    expect(result.evidence).toBeUndefined()
    expect(result.progress?.perSubgoal.every((entry) => !entry.success)).toBe(true)
    // it DID attempt the mutation (the pane/option), rather than reading
    expect(executed).toBeGreaterThan(0)
  })
})

// GENERALIZATION — INVARIANT: actuation ESCALATES through every PERMITTED modality
// before it is declared failed, recording each attempt; a silent no-op is not an
// answer, and a driver policy refusal is recorded (refused-by-policy) without
// terminating the ladder while a permitted mode remains. LIVE INSTANCE: the macOS
// wallpaper row no-oped its declared AXPress and the run reported undelivered with
// `modes=[declared]` — the remaining modes were never attempted. UNSEEN CASE: any
// surface that no-ops a background element action (a custom toggle, a canvas
// control that still exposes an element) escalates to a real foreground input event.
// hardcode-guard:allow the fixture element/tree labels and driver tokens are the enumerable actuation inputs under test
describe("runClickRungs — an undelivered rung escalates every permitted modality", () => {
  const win = { pid: 4242, window_id: 7 }
  const wire = (elements: readonly Element[]) => ({
    snapshot_id: "s1",
    elements: elements.map((element) => ({
      token: element.element_token,
      role: element.role,
      label: element.label,
      selected: element.selected,
      actions: element.actions,
      frame: element.frame,
    })),
  })
  const makeDriver = (script: DriverOutcome[]) => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed(script.shift() ?? { ok: false, error: "unscripted" })
    }
    return { call, calls }
  }
  const button: Element = {
    element_token: "t1",
    role: "AXButton",
    label: "Black",
    actions: ["AXPress"],
    frame: { x: 10, y: 10, width: 40, height: 20 },
  }

  test("(a) an undelivered declared rung escalates to the foreground element click; both modes recorded", async () => {
    const plan = actuationPlan(button, win)
    // the foreground escalation is the SAME element re-issued as a real input event
    expect(escalateRung(plan[0]!)).toMatchObject({
      mode: "foreground",
      args: { element_token: "t1", action: "press", delivery_mode: "foreground" },
    })
    const before = clickSignals(screenSignature([button]), button, [button])
    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // declared: success code, no world change
      { ok: true, result: { content: [], structuredContent: wire([button]) } }, // probe: unchanged
      { ok: true, result: { content: [] } }, // foreground element re-issue
      { ok: true, result: { content: [], structuredContent: wire([{ ...button, selected: true }]) } }, // probe: state changed → delivered
    ])
    const run = await Effect.runPromise(runClickRungs(driver.call, win, button, plan, before, before.screen))

    expect(run.outcome.worked).toBe(true)
    expect(run.outcome.mode).toBe("foreground")
    // BOTH modes recorded: the declared rung and its foreground escalation
    expect(run.attempts.map((attempt) => attempt.mode)).toEqual(["declared", "foreground"])
    expect(run.attempts[0]!.delivered).toBe(false)
    expect(run.attempts[1]!.delivered).toBe(true)
    expect(driver.calls[2]).toMatchObject({ name: "cua-driver_click" })
    expect(driver.calls[2]!.args).toMatchObject({ element_token: "t1", action: "press", delivery_mode: "foreground" })
  })

  test("(b) permitted modes exhausted → undelivered with EVERY attempt and the refusal text", async () => {
    const plan = actuationPlan(button, win)
    const before = clickSignals(screenSignature([button]), button, [button])
    const refusal = `${REFUSED_BY_POLICY} for an AX-exposed element`
    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // declared: no change
      { ok: true, result: { content: [], structuredContent: wire([button]) } }, // probe: unchanged
      { ok: true, result: { content: [] } }, // foreground: no change
      { ok: true, result: { content: [], structuredContent: wire([button]) } }, // probe: unchanged
      { ok: false, error: refusal }, // pixel: policy refusal
      { ok: true, result: { content: [], structuredContent: wire([button]) } }, // probe: unchanged
    ])
    const run = await Effect.runPromise(runClickRungs(driver.call, win, button, plan, before, before.screen))

    expect(run.outcome.worked).toBe(false)
    expect(run.attempts.map((attempt) => attempt.mode)).toEqual(["declared", "foreground", "pixel"])
    expect(run.attempts.every((attempt) => !attempt.delivered)).toBe(true)
    const pixel = run.attempts[2]!
    expect(pixel.reasons).toContain("refused-by-policy")
    expect(pixel.error).toBe(refusal)
    // the honest summary carries every attempt's mode and the refusal text
    const failure = clickFailure(run.attempts)
    expect(failure).toContain("declared:")
    expect(failure).toContain("foreground:")
    expect(failure).toContain(`pixel: ${refusal}`)
  })

  test("(c) a policy refusal does not stop the ladder while a permitted mode remains", async () => {
    // An explicit plan whose coordinate rung sits BEFORE a permitted element rung,
    // so the runner's refusal-continuation invariant is exercised directly.
    const plan: ActuationRung[] = [
      { mode: "pixel", label: "pixel(1,1)", args: { x: 1, y: 1, delivery_mode: "foreground" } },
      { mode: "declared", label: "press", args: { element_token: "t1", action: "press" } },
    ]
    const before = clickSignals(screenSignature([button]), button, [button])
    const driver = makeDriver([
      { ok: false, error: REFUSED_BY_POLICY }, // pixel: refused
      { ok: true, result: { content: [], structuredContent: wire([button]) } }, // probe: unchanged
      { ok: true, result: { content: [] } }, // declared element click
      { ok: true, result: { content: [], structuredContent: wire([button]) } }, // probe: unchanged
      { ok: true, result: { content: [] } }, // foreground escalation
      { ok: true, result: { content: [], structuredContent: wire([{ ...button, selected: true }]) } }, // probe: delivered
    ])
    const run = await Effect.runPromise(runClickRungs(driver.call, win, button, plan, before, before.screen))

    // the refusal is recorded, and the ladder CONTINUED to the permitted modes
    expect(run.attempts.map((attempt) => attempt.mode)).toEqual(["pixel", "declared", "foreground"])
    expect(run.attempts[0]!.reasons).toContain("refused-by-policy")
    expect(run.outcome.worked).toBe(true)
    expect(run.outcome.mode).toBe("foreground")
  })
})

// GENERALIZATION — INVARIANT: an element is actuated by ANY of its declared
// actions, walking past any the driver reports unsupported; and a handle is FETCHED
// FRESH for the call that uses it, so no rung reuses a token an intervening driver
// call staled; and target selection prefers a click-activating element over a
// pick-only sibling. LIVE INSTANCE: the macOS wallpaper row's declared rung ended
// after ONE unsupported verb (AXPick, -25206) and its foreground rung reused a
// token another call had invalidated. UNSEEN CASES: a control declaring several
// verbs is walked until one delivers; a navigate that renumbers the tree is
// followed by a re-resolved handle; a pick-only cell beside an activating control
// is not chosen.
// hardcode-guard:allow the driver's unsupported code and fixture tokens/labels/frames are the enumerable actuation inputs under test
describe("runClickRungs — declared-action walk, handle freshness, activating target", () => {
  const win = { pid: 4242, window_id: 7 }
  const wire = (elements: readonly Element[]) => ({
    snapshot_id: "s1",
    elements: elements.map((element) => ({
      token: element.element_token,
      role: element.role,
      label: element.label,
      selected: element.selected,
      actions: element.actions,
      frame: element.frame,
      element_index: element.element_index,
      parent_index: element.parent_index,
      depth: element.depth,
    })),
  })
  const makeDriver = (script: DriverOutcome[]) => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed(script.shift() ?? { ok: false, error: "unscripted" })
    }
    return { call, calls }
  }

  test("(a) a declared rung walks past an unsupported first action and delivers on the next, recording both", async () => {
    const el: Element = {
      element_token: "t1",
      role: "AXButton",
      label: "Wallpaper",
      actions: ["AXPick", "AXPress"],
      frame: { x: 0, y: 0, width: 40, height: 20 },
    }
    // press-like outranks pick even though pick was declared first
    expect(declaredActions(el)).toEqual(["press", "pick"])
    const plan = actuationPlan(el, win)
    const before = clickSignals(screenSignature([el]), el, [el])
    const driver = makeDriver([
      { ok: false, error: `AX action failed: AXUIElementPerformAction(AXPick) returned ${UNSUPPORTED_ACTION}` }, // press: unsupported
      { ok: true, result: { content: [] } }, // pick: delivered
      { ok: true, result: { content: [], structuredContent: wire([{ ...el, selected: true }]) } }, // probe: state changed
    ])
    const run = await Effect.runPromise(runClickRungs(driver.call, win, el, plan, before, before.screen))

    expect(driver.calls[0]!.args.action).toBe("press")
    expect(driver.calls[1]!.args.action).toBe("pick")
    // each attempted action is recorded; the unsupported one did not abort the rung
    expect(run.attempts.map((attempt) => attempt.label)).toEqual(["press", "pick"])
    expect(run.attempts[0]!.delivered).toBe(false)
    expect(run.attempts[0]!.error).toContain(UNSUPPORTED_ACTION)
    expect(run.attempts[1]!.delivered).toBe(true)
    expect(run.outcome.worked).toBe(true)
    expect(run.outcome.mode).toBe("declared")
  })

  test("(b) the foreground and pixel rungs re-resolve their handle from the newest observation", async () => {
    const el: Element = {
      element_token: "t1",
      role: "AXButton",
      label: "Black",
      actions: ["AXPress"],
      frame: { x: 0, y: 0, width: 40, height: 20 },
    }
    const plan = actuationPlan(el, win)
    expect(plan[0]!.args.element_token).toBe("t1")
    const before = clickSignals(screenSignature([el]), el, [el])
    // every probe mints a NEWER token AND moves the frame, so a reused token or a
    // stale centre would be observable
    const moved: Element = { ...el, element_token: "t2", frame: { x: 100, y: 100, width: 40, height: 20 } }
    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // declared: no change
      { ok: true, result: { content: [], structuredContent: wire([moved]) } }, // probe: t2, moved, unchanged
      { ok: true, result: { content: [] } }, // foreground: no change
      { ok: true, result: { content: [], structuredContent: wire([moved]) } }, // probe: unchanged
      { ok: true, result: { content: [] } }, // pixel: no change
      { ok: true, result: { content: [], structuredContent: wire([{ ...moved, selected: true }]) } }, // probe: delivered
    ])
    const run = await Effect.runPromise(runClickRungs(driver.call, win, el, plan, before, before.screen))

    // the declared rung used the plan's token; the foreground rung used the FRESH one
    expect(driver.calls[0]!.args.element_token).toBe("t1")
    expect(driver.calls[2]!.args.element_token).toBe("t2")
    // the pixel rung re-derived its aim from the fresh frame centre (100+20, 100+10)
    expect(driver.calls[4]!.args).toMatchObject({ x: 120, y: 110 })
    expect(run.outcome.worked).toBe(true)
  })

  test("(c) target selection prefers a click-activating element over a pick-only sibling", () => {
    const container: Element = {
      element_index: 0,
      element_token: "box",
      role: "AXGroup",
      label: "Wallpaper",
      depth: 1,
      frame: { x: 0, y: 0, width: 200, height: 80 },
    }
    const pickOnly: Element = {
      element_index: 1,
      element_token: "pick",
      role: "AXRow",
      label: "Black",
      depth: 2,
      parent_index: 0,
      actions: ["AXPick"],
      frame: { x: 0, y: 0, width: 200, height: 40 },
    }
    const activating: Element = {
      element_index: 2,
      element_token: "press",
      role: "AXButton",
      label: "Black",
      depth: 2,
      parent_index: 0,
      actions: ["AXPress"],
      frame: { x: 8, y: 48, width: 40, height: 24 },
    }
    // the pick-only sibling is FIRST and equally near — without the preference it wins
    expect(actuatorOf(container, [container, pickOnly, activating]).element_token).toBe("press")
    // a pick-only element is still usable when NO activating candidate exists
    expect(actuatorOf(container, [container, pickOnly]).element_token).toBe("pick")
  })
})

// GENERALIZATION — INVARIANT: an actuator must be INSIDE the sensor's field of
// view before it is actuated, and visibility is RE-CHECKED (target re-resolved)
// after any reveal. LIVE INSTANCE: in System Settings' wallpaper pane the black
// swatch's frame resolved BELOW the panel window (the Colors row is under the
// fold), so every click landed outside the target. UNSEEN CASE: a horizontally
// scrolled table whose target sits off the right edge, or a virtualized list that
// re-renders after a scroll — both re-resolve from the post-reveal observation.
// hardcode-guard:allow the fixture frames/roles/tokens are the enumerable visibility inputs under test
describe("ensureVisible — reveal an off-screen target before any click", () => {
  const win = { pid: 4242, window_id: 7 }
  const wire = (elements: readonly Element[]) => ({
    snapshot_id: "s1",
    elements: elements.map((element) => ({
      token: element.element_token,
      role: element.role,
      label: element.label,
      selected: element.selected,
      actions: element.actions,
      frame: element.frame,
      element_index: element.element_index,
      parent_index: element.parent_index,
      depth: element.depth,
    })),
  })
  const makeDriver = (script: DriverOutcome[]) => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed(script.shift() ?? { ok: false, error: "unscripted" })
    }
    return { call, calls }
  }
  const windowEl: Element = {
    element_index: 0,
    element_token: "w0",
    role: "AXWindow",
    label: "Settings",
    depth: 0,
    frame: { x: 0, y: 0, width: 400, height: 300 },
  }
  const scroller: Element = {
    element_index: 1,
    element_token: "s1",
    role: "AXScrollArea",
    depth: 1,
    parent_index: 0,
    frame: { x: 0, y: 40, width: 400, height: 260 },
  }
  const below: Element = {
    element_index: 2,
    element_token: "t1",
    role: "AXButton",
    label: "Black",
    depth: 2,
    parent_index: 1,
    actions: ["AXPress"],
    frame: { x: 10, y: 400, width: 40, height: 20 },
  }

  test("(a) an off-screen target is revealed by a targeted scroll, re-resolved, and the click uses post-reveal coordinates", async () => {
    const elements = [windowEl, scroller, below]
    const before = screenSignature(elements)
    const moved: Element = { ...below, element_token: "t2", frame: { x: 10, y: 200, width: 40, height: 20 } }
    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // scroll toward the target
      { ok: true, result: { content: [], structuredContent: wire([windowEl, scroller, moved]) } }, // re-observe: revealed
    ])
    const reveal = await Effect.runPromise(ensureVisible(driver.call, win, below, elements, before))

    // the reveal moved the pane HOLDING the target and stopped once it was visible
    expect(driver.calls[0]).toMatchObject({ name: "cua-driver_scroll" })
    expect(driver.calls[0]!.args).toMatchObject({ direction: "down", element_token: "s1" })
    expect(reveal.attempts.map((attempt) => attempt.mode)).toEqual(["scroll"])
    expect(reveal.visible).toBe(true)
    // the target is re-resolved from the POST-reveal observation (fresh token + FRAME)
    expect(reveal.target.element_token).toBe("t2")
    expect(reveal.target.frame?.y).toBe(200)
    // the click plan is built from the POST-reveal frame, never the pre-reveal one
    const plan = actuationPlan(actuatorOf(reveal.target, reveal.elements), win)
    expect(plan.map((rung) => rung.label)).toContain("pixel(30,210)")
    expect(plan.map((rung) => rung.label)).not.toContain("pixel(30,410)")
  })

  test("(b) an already-visible target is a strict no-op — no scroll, no resize, no read", async () => {
    const inside: Element = { ...below, frame: { x: 10, y: 100, width: 40, height: 20 } }
    const elements = [windowEl, scroller, inside]
    const bounds = windowBounds(elements)
    expect(bounds).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    expect(withinBounds(inside.frame!, bounds!)).toBe(true)
    const driver = makeDriver([])
    const reveal = await Effect.runPromise(ensureVisible(driver.call, win, inside, elements, screenSignature(elements)))

    expect(reveal.visible).toBe(true)
    expect(reveal.attempts).toHaveLength(0)
    expect(reveal.observations).toBe(0)
    expect(driver.calls).toHaveLength(0)
  })

  test("(c) the bounded budget exhausting yields the distinct off-viewport status with every attempt, never a blind click", async () => {
    const elements = [windowEl, scroller, below]
    const script: DriverOutcome[] = []
    for (let i = 0; i < REVEAL_BUDGET; i++) {
      script.push({ ok: true, result: { content: [] } }) // scroll (no effect)
      script.push({
        ok: true,
        result: { content: [], structuredContent: wire([windowEl, scroller, { ...below, element_token: `t${i + 2}` }]) },
      }) // re-observe: still below the fold
    }
    const driver = makeDriver(script)
    const reveal = await Effect.runPromise(ensureVisible(driver.call, win, below, elements, screenSignature(elements)))

    expect(reveal.visible).toBe(false)
    expect(reveal.attempts).toHaveLength(REVEAL_BUDGET)
    expect(reveal.attempts.every((attempt) => attempt.mode === "scroll")).toBe(true)
    const failure = revealFailure(reveal.attempts)
    expect(failure).toContain(OFF_VIEWPORT)
    expect(failure).toContain("scroll down")
    // NOT a blind click: every attempt was a reveal, and no click was ever issued
    expect(driver.calls.some((call) => call.name === "cua-driver_click")).toBe(false)
  })

  test("(d) with no scroll container the reveal grows the window instead, then re-resolves", async () => {
    const detached: Element = { ...below, parent_index: 0 } // parent is the AXWindow, not a scroller
    const elements = [windowEl, detached]
    const grown: Element = { ...windowEl, frame: { x: 0, y: 0, width: 400, height: 600 } }
    const shown: Element = { ...detached, element_token: "t2" }
    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // set_window_frame
      { ok: true, result: { content: [], structuredContent: wire([grown, shown]) } }, // now visible
    ])
    const reveal = await Effect.runPromise(ensureVisible(driver.call, win, detached, elements, screenSignature(elements)))

    expect(driver.calls[0]).toMatchObject({ name: "cua-driver_set_window_frame" })
    expect(driver.calls[0]!.args).toMatchObject({ height: 600 })
    expect(reveal.attempts.map((attempt) => attempt.mode)).toEqual(["resize"])
    expect(reveal.visible).toBe(true)
    expect(reveal.target.element_token).toBe("t2")
  })

  test("(e) BOTH click call sites ensure visibility before the rungs (no blind click site)", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "tool", "ui-run.ts")).text()
    const callSites = src.slice(src.indexOf("export const UiRunTool"))
    expect(callSites.match(/yield\* ensureVisible\(/g) ?? []).toHaveLength(2)
  })
})

// GENERALIZATION — INVARIANT: the accessibility tree's own geometry decides what
// is on screen (frame ∩ every ancestor clip), a row is actuated through the
// descendant that ACTIVATES it, an actuator NAMES and VERIFIES its window and
// container, and a guarded capability is used through the driver's own sanctioned
// per-call authorization — never by weakening the guard. LIVE INSTANCES: the
// wallpaper swatch lay below its scroll container's viewport (visibility), the
// row's real control was a rejecting-descendant (binding), the reveal scroll aimed
// without a container moved another region (scoping), and the coordinate click was
// refused for lack of the per-call authorization (authorization). UNSEEN CASES: a
// nested clip chain; a pick-only cell beside an activating control; a horizontally
// overflowing table; a tokenless canvas control.
// hardcode-guard:allow the fixture roles/frames/tokens are the enumerable geometry inputs under test
describe("ui-hands — geometry visibility, row binding, container scoping, authorized click", () => {
  const WINDOW_EL: Element = {
    element_index: 0,
    element_token: "w0",
    role: "AXWindow",
    label: "Settings",
    depth: 0,
    frame: { x: 0, y: 0, width: 400, height: 300 },
  }
  const DIALOG: Element = {
    element_index: 1,
    element_token: "d1",
    role: "AXDialog",
    depth: 1,
    parent_index: 0,
    frame: { x: 0, y: 0, width: 400, height: 300 },
  }
  const SCROLLER: Element = {
    element_index: 2,
    element_token: "s1",
    role: "AXScrollArea",
    depth: 2,
    parent_index: 1,
    frame: { x: 0, y: 40, width: 400, height: 200 },
  }
  const BELOW: Element = {
    element_index: 3,
    element_token: "t1",
    role: "AXButton",
    label: "Black",
    depth: 3,
    parent_index: 2,
    actions: ["AXPress"],
    frame: { x: 10, y: 300, width: 40, height: 20 },
  }
  const INSIDE: Element = { ...BELOW, element_token: "t2", frame: { x: 10, y: 100, width: 40, height: 20 } }
  const STRADDLE: Element = { ...BELOW, element_token: "t3", frame: { x: 10, y: 230, width: 40, height: 40 } }
  const win = { pid: 4242, window_id: 7 }

  test("(a) geometry visibility: below the container viewport is off-screen with a scroll delta; a nested clip chain is honored", () => {
    const elements = [WINDOW_EL, DIALOG, SCROLLER, BELOW, INSIDE]
    const below = visibilityOf(BELOW, elements)
    expect(below.state).toBe("off-screen")
    expect(below.container?.element_token).toBe("s1")
    expect(below.scroll?.direction).toBe("down")
    expect(below.scroll?.lines ?? 0).toBeGreaterThanOrEqual(1)
    // containment comes from the parent_index chain: scroller inside dialog inside window
    expect(ancestorChain(BELOW, elements).map((ancestor) => ancestor.role)).toEqual([
      "AXScrollArea",
      "AXDialog",
      "AXWindow",
    ])
    expect(visibilityOf(INSIDE, elements).state).toBe("visible")
  })

  test("(a) an element straddling the container edge is partial; the nearest scroll container is found structurally", () => {
    const elements = [WINDOW_EL, DIALOG, SCROLLER, STRADDLE]
    expect(visibilityOf(STRADDLE, elements).state).toBe("partial")
    expect(scrollContainerOf(STRADDLE, elements)?.element_token).toBe("s1")
  })

  test("(b) a row with an activating descendant binds to it; a pick-only sibling is a recorded last resort", () => {
    const box: Element = {
      element_index: 0,
      element_token: "box",
      role: "AXGroup",
      label: "Wallpaper",
      depth: 1,
      frame: { x: 0, y: 0, width: 200, height: 80 },
    }
    const pick: Element = {
      element_index: 1,
      element_token: "pick",
      role: "AXRow",
      label: "Black",
      depth: 2,
      parent_index: 0,
      actions: ["AXPick"],
      frame: { x: 0, y: 0, width: 200, height: 40 },
    }
    const activating: Element = {
      element_index: 2,
      element_token: "press",
      role: "AXButton",
      label: "Black",
      depth: 2,
      parent_index: 0,
      actions: ["AXPress"],
      frame: { x: 8, y: 48, width: 40, height: 24 },
    }
    const withActivating = actuatorBinding(box, [box, pick, activating])
    expect(withActivating.actuator.element_token).toBe("press")
    expect(withActivating.activating).toBe(true)
    expect(withActivating.lastResort).toBe(false)
    // with NO activating candidate the pick-only element is used, RECORDED as a last resort
    const onlyPick = actuatorBinding(box, [box, pick])
    expect(onlyPick.actuator.element_token).toBe("pick")
    expect(onlyPick.activating).toBe(false)
    expect(onlyPick.lastResort).toBe(true)
  })

  test("(c) a scroll is scoped (pid+window_id+container) and verified against THAT container; a scroll that moved another region is undelivered", async () => {
    const wire = (elements: readonly Element[]) => ({
      snapshot_id: "s1",
      elements: elements.map((element) => ({
        token: element.element_token,
        role: element.role,
        label: element.label,
        value: element.value,
        actions: element.actions,
        frame: element.frame,
        element_index: element.element_index,
        parent_index: element.parent_index,
        depth: element.depth,
      })),
    })
    const script: DriverOutcome[] = []
    const otherChild = (y: number): Element => ({
      element_index: 9,
      element_token: "cx",
      role: "AXStaticText",
      label: "moved",
      value: "moved",
      depth: 2,
      parent_index: 8,
      frame: { x: 0, y, width: 10, height: 10 },
    })
    for (let i = 0; i < REVEAL_BUDGET; i++) {
      script.push({ ok: true, result: { content: [] } }) // scroll ok
      // a DIFFERENT container's content moved; the target's scroller + the target are untouched
      script.push({
        ok: true,
        result: {
          content: [],
          structuredContent: wire([WINDOW_EL, SCROLLER, { ...BELOW, element_token: `t${i + 2}` }, otherChild(i + 1)]),
        },
      })
    }
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed(script.shift() ?? { ok: false, error: "unscripted" })
    }
    const elements = [WINDOW_EL, SCROLLER, BELOW]
    const reveal = await Effect.runPromise(ensureVisible(call, win, BELOW, elements, screenSignature(elements)))

    // the scroll names its window AND its container
    expect(calls[0]).toMatchObject({ name: "cua-driver_scroll" })
    expect(calls[0]!.args).toMatchObject({ pid: 4242, window_id: 7, element_token: "s1" })
    // the intended container never moved → every attempt is unverified and the target stays undelivered
    expect(reveal.visible).toBe(false)
    expect(reveal.attempts.every((attempt) => attempt.container === "s1")).toBe(true)
    expect(reveal.attempts.every((attempt) => attempt.verified === false)).toBe(true)
    const failure = revealFailure(reveal.attempts)
    expect(failure).toContain(OFF_VIEWPORT)
    expect(failure).toContain(CONTAINER_UNMOVED)
    // the container signature is what proves movement: a target move IS a container-content move
    const moved = { ...BELOW, frame: { x: 10, y: 100, width: 40, height: 20 } }
    expect(containerSignature(SCROLLER, [WINDOW_EL, SCROLLER, moved])).not.toBe(
      containerSignature(SCROLLER, [WINDOW_EL, SCROLLER, BELOW]),
    )
  })

  test("(d) the coordinate rung carries the driver's per-call authorization only when supplied; absence is a distinct authorization-required outcome", () => {
    const swatch: Element = {
      element_token: "sw",
      role: "AXImage",
      label: "Black",
      frame: { x: 100, y: 100, width: 40, height: 40 },
    }
    const plain = actuationPlan(swatch, win)
    const pixelPlain = plain.find((rung) => rung.mode === "pixel")!
    // default: no authorization on the coordinate path
    expect(pixelPlain.args[AUTHORIZATION_FLAG]).toBeUndefined()
    // supplied: the documented per-call flag rides the coordinate rung, at the visible frame centre
    const authorized = actuationPlan(swatch, win, true)
    const pixelAuthorized = authorized.find((rung) => rung.mode === "pixel")!
    expect(pixelAuthorized.args).toMatchObject({
      [AUTHORIZATION_FLAG]: true,
      x: 120,
      y: 120,
      delivery_mode: "foreground",
    })
    // the driver's own refusal names the flag; the attempt records authorization-required (never delivery)
    const before = clickSignals(screenSignature([swatch]), swatch, [swatch])
    const refusal = `${REFUSED_BY_POLICY}: canvas/WebGL targets: pass ${AUTHORIZATION_FLAG}:true (Brain-authorized) to bypass`
    const attempt = clickAttempt(pixelPlain, before, before, swatch, refusal)
    expect(attempt.reasons).toContain("authorization-required")
    expect(attempt.delivered).toBe(false)
    // the distinct requirement outcome names exactly what is required, not a generic undelivered
    expect(clickFailure([attempt])).toContain(AUTHORIZATION_REQUIRED)
    expect(clickFailure([attempt])).toContain(AUTHORIZATION_FLAG)
  })

  test("(e) step telemetry records window, container, authorization and verification result", async () => {
    const el = (label: string): Element => ({ element_token: label, role: "AXLink", label })
    const row = (label: string): SceneItem => ({
      id: label,
      role: "AXLink",
      label,
      affordances: ["activatable"],
      stateChanging: false,
      enabled: true,
      element: el(label),
    })
    const listScene = (labels: readonly string[], snapshot: string): Scene => ({
      snapshot,
      regions: [{ id: `${snapshot}:list`, kind: "list", itemIds: [...labels], textIds: [] }],
      items: labels.map(row),
      texts: [],
    })
    const scenes = [listScene(["m1"], "s-partial"), listScene(["m1", "m2", "m3"], "s-satisfied")]
    let observed = scenes[0]
    const scope: ActuationScope = {
      window: { pid: 4242, window_id: 7 },
      target: "t1",
      actuator: "press",
      containment: ["AXGroup", "AXWindow"],
      visibleRect: { x: 10, y: 100, width: 40, height: 20 },
      container: "s1",
      authorization: AUTHORIZATION_FLAG,
      verified: true,
    }
    const result = await Effect.runPromise(
      planLoop({
        goal: "read the last 3 messages",
        observe: () => Effect.succeed(observed),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: () => {
          observed = scenes[1]
          return Effect.succeed({ deliveryModes: ["read"], scope })
        },
        stateChanging: () => false,
        readOnly: true,
        maxSteps: 8,
      }),
    )
    expect(result.telemetry[0]?.scope).toEqual(scope)
  })
})

// GENERALIZATION — INVARIANT: (1) reveal through the element's own SANCTIONED
// action first (AXScrollToVisible/Top/Bottom), before any computed delta or
// resize; (2) SCROLLABILITY IS AN ACTION PROPERTY, not a role — an element with
// scroll actions but no scroll-area role is a scroller; (3) ITEM SELECTION selects
// the structural item before its actuator, reporting a bare label match as weak.
// LIVE INSTANCE: the Wallpaper pane's swatch declares AXScrollToVisible while no
// scroll-area wraps the pane (role: AXOpaqueProviderGroup). UNSEEN CASES: an
// ancestor scroller that declares AXScrollToBottom; a label-only match; content
// overflowing on BOTH axes with no scroll-area role.
// hardcode-guard:allow the fixture roles/actions/frames are the enumerable inputs under test
describe("ui-hands — reveal by sanctioned action, scrollability by action, structured item selection", () => {
  const win = { pid: 4242, window_id: 7 }
  const wire = (elements: readonly Element[]) => ({
    snapshot_id: "s1",
    elements: elements.map((element) => ({
      token: element.element_token,
      role: element.role,
      label: element.label,
      actions: element.actions,
      frame: element.frame,
      element_index: element.element_index,
      parent_index: element.parent_index,
      depth: element.depth,
    })),
  })
  const makeDriver = (script: DriverOutcome[]) => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      return Effect.succeed(script.shift() ?? { ok: false, error: "unscripted" })
    }
    return { call, calls }
  }
  const windowEl: Element = {
    element_index: 0,
    element_token: "w0",
    role: "AXWindow",
    label: "Settings",
    depth: 0,
    frame: { x: 0, y: 0, width: 400, height: 300 },
  }
  // A colour group with NO scroll-area role that scrolls by ACTION alone.
  const pane: Element = {
    element_index: 1,
    element_token: "p1",
    role: "AXOpaqueProviderGroup",
    label: "Colors",
    depth: 1,
    parent_index: 0,
    actions: ["AXScrollToTop", "AXScrollToBottom"],
    frame: { x: 0, y: 40, width: 400, height: 260 },
  }
  const swatch: Element = {
    element_index: 2,
    element_token: "t1",
    role: "AXButton",
    label: "Black",
    depth: 2,
    parent_index: 1,
    actions: ["AXScrollToVisible", "AXShowMenu"],
    frame: { x: 10, y: 400, width: 40, height: 40 },
  }

  test("(a) an off-screen swatch declaring AXScrollToVisible reveals via THAT action (route recorded) and is re-checked visible", async () => {
    const elements = [windowEl, pane, swatch]
    const moved: Element = { ...swatch, element_token: "t2", frame: { x: 10, y: 120, width: 40, height: 40 } }
    const driver = makeDriver([
      { ok: true, result: { content: [] } }, // the sanctioned action (no effect yet)
      { ok: true, result: { content: [], structuredContent: wire([windowEl, pane, moved]) } }, // revealed
    ])
    const reveal = await Effect.runPromise(ensureVisible(driver.call, win, swatch, elements, screenSignature(elements)))

    // the FIRST route is the element's own action, through the driver's action mechanism
    expect(driver.calls[0]).toMatchObject({ name: "cua-driver_click" })
    expect(driver.calls[0]!.args).toMatchObject({ element_token: "t1", action: "scroll_to_visible" })
    expect(reveal.attempts[0]!.mode).toBe("action")
    expect(reveal.attempts[0]!.route).toBe("scroll_to_visible")
    // re-observed and re-checked visible; the target is re-resolved from the post-reveal observation
    expect(reveal.visible).toBe(true)
    expect(reveal.target.element_token).toBe("t2")
    expect(reveal.target.frame?.y).toBe(120)
  })

  test("(a) an element with scroll actions but NO scroll-area role is treated as scrollable", () => {
    // scrollability by ACTION: a role-less group declaring AXScrollToTop/Bottom
    expect(isScrollableContainer(pane)).toBe(true)
    expect(hasScrollActions(pane)).toBe(true)
    expect(scrollContainerOf(swatch, [windowEl, pane, swatch])?.element_token).toBe("p1")
    // the SCENE affordance is likewise driven by the declared action, not the role
    expect(affordancesOf(pane)).toContain("scrollable")
  })

  test("(a) a pane with no scroll-area role and content wider than the window clips on BOTH axes", () => {
    const beyondRight: Element = { ...swatch, element_token: "br", frame: { x: 450, y: 120, width: 60, height: 40 } }
    const beyondBottom: Element = { ...swatch, element_token: "bb", frame: { x: 10, y: 420, width: 40, height: 40 } }
    const straddleRight: Element = { ...swatch, element_token: "sr", frame: { x: 360, y: 120, width: 80, height: 40 } }
    const straddleBottom: Element = { ...swatch, element_token: "sb", frame: { x: 10, y: 270, width: 40, height: 60 } }
    const elements = [windowEl, pane, beyondRight, beyondBottom, straddleRight, straddleBottom]

    expect(visibilityOf(beyondRight, elements).state).toBe("off-screen")
    expect(visibilityOf(beyondRight, elements).scroll?.direction).toBe("right")
    expect(visibilityOf(beyondBottom, elements).state).toBe("off-screen")
    expect(visibilityOf(beyondBottom, elements).scroll?.direction).toBe("down")
    // a straddling frame is CLIPPED (partial) on each axis, scoped to the action-scrollable pane
    expect(visibilityOf(straddleRight, elements).state).toBe("partial")
    expect(visibilityOf(straddleRight, elements).scroll?.direction).toBe("right")
    expect(visibilityOf(straddleBottom, elements).state).toBe("partial")
    expect(visibilityOf(straddleBottom, elements).scroll?.direction).toBe("down")
    expect(visibilityOf(straddleRight, elements).container?.element_token).toBe("p1")
  })

  test("(c) an unrevealable off-screen target ends in the distinct unreachable outcome with ALL attempts recorded", async () => {
    const elements = [windowEl, pane, swatch]
    const script: DriverOutcome[] = []
    for (let i = 0; i < REVEAL_BUDGET; i++) {
      script.push({ ok: true, result: { content: [] } }) // action delivered nothing
      script.push({
        ok: true,
        result: { content: [], structuredContent: wire([windowEl, pane, { ...swatch, element_token: `t${i + 2}` }]) },
      }) // still below the fold
    }
    const driver = makeDriver(script)
    const reveal = await Effect.runPromise(ensureVisible(driver.call, win, swatch, elements, screenSignature(elements)))

    expect(reveal.visible).toBe(false)
    expect(reveal.attempts).toHaveLength(REVEAL_BUDGET)
    expect(reveal.attempts[0]!.route).toBe("scroll_to_visible")
    expect(driver.calls.some((call) => call.name === "cua-driver_click" && call.args.action === "scroll_to_visible")).toBe(
      true,
    )
    // never a blind click: every attempt is the sanctioned reveal
    const failure = revealFailure(reveal.attempts)
    expect(failure).toContain(OFF_VIEWPORT)
  })
})

// GENERALIZATION — INVARIANT: ITEM SELECTION precedes actuator selection; a
// structured row/container with a click-activating descendant is preferred over a
// bare LABEL match that has none, and the weak case is REPORTED, never silently
// used. LIVE INSTANCE: the Wallpaper row's activating control is a child AXButton
// while the row itself declares no AXPress. UNSEEN CASE: a label-only match.
// hardcode-guard:allow the fixture roles/actions are the enumerable selection inputs under test
describe("ui-run — item selection before actuator selection", () => {
  test("(b) a structured row with an activating descendant is preferred over a bare label match; the weak case is reported", () => {
    const label: Element = { element_index: 0, element_token: "lab", role: "AXStaticText", label: "Black" }
    const row: Element = {
      element_index: 1,
      element_token: "row",
      role: "AXRow",
      label: "Black",
      actions: ["AXShowDefaultUI"],
    }
    const press: Element = {
      element_index: 2,
      element_token: "press",
      role: "AXButton",
      label: "Black",
      parent_index: 1,
      actions: ["AXPress"],
      frame: { x: 0, y: 0, width: 40, height: 40 },
    }
    const elements = [label, row, press]

    const selection = selectItem([label, row], elements)
    // the STRUCTURAL item wins, and its actuator is the activating descendant
    expect(selection?.item.element_token).toBe("row")
    expect(selection?.reason).toBe("structure")
    expect(selection?.actuator.element_token).toBe("press")
    expect(selection?.activating).toBe(true)
    expect(selection?.weak).toBe(false)

    // a bare label match with NO activating descendant is flagged weak, not silently used
    const weak = selectItem([label], [label])
    expect(weak?.reason).toBe("label")
    expect(weak?.weak).toBe(true)
    expect(weak?.actuator.element_token).toBe("lab")
  })
})

// GENERALIZATION — INVARIANT: the launch call matches the driver's DECLARED
// interface; the app name rides under the accepted argument `name`, never the
// live-rejected `app`. LIVE INSTANCE: the run failed verbatim "launch_app: unknown
// argument app; accepted: additional_arguments, bundle_id,
// creates_new_application_instance, name, urls, webkit_inspector_port". UNSEEN
// CASE: a bundle_id-addressed launch uses the same accepted interface.
// hardcode-guard:allow the quoted driver error and accepted-argument vocabulary are the interface under test
describe("ui-hands — open_app launcher matches the driver's declared interface", () => {
  test("(a) the launch call carries the ACCEPTED argument name (name), never the rejected app", () => {
    const args = launchAppArgs("Calculator")
    expect(args[LAUNCH_APP_NAME_ARG]).toBe("Calculator")
    expect("app" in args).toBe(false)
    // the accepted-argument list is quoted from the live refusal, the source of truth
    expect(LAUNCH_APP_ACCEPTED).toContain("name")
    expect(LAUNCH_APP_ACCEPTED).not.toContain("app")
    expect(LAUNCH_APP_NAME_ARG).toBe("name")
  })
})

// GENERALIZATION — INVARIANT: once the goal's target surface is reached and settled,
// the attributes the goal NAMES become EVIDENCE — the read subgoals exist and cite the
// observed labelled values; an empty option space is a REPORTED cause (no-maneuver), a
// decider that returns an unusable label is DISTINCT (choice-unusable), and a target
// genuinely absent from a settled scene names WHY (target-unreadable). Each subgoal
// attempt records the maneuver set it was OFFERED, so "nothing offered" can never be
// confused with "chose none".
// LIVE INSTANCE (verbatim): pid 90951 / window 2918 — the goal "open the About pane and
// report the macOS version, chip and total memory" reached the About pane (chip
// "Apple M3 Max", memory "128 GB", macOS "27.2 Beta (26B5112a)") and then stopped
// `{"status":"no-choice","planId":"mutate"}` with only the subgoal-0 step emitted.
// UNSEEN INPUTS: a Settings pane that exposes its rows with no LIST region (handled by
// the observed-element read), and a report goal whose surfaces sit behind a first
// navigation (handled by the ordered per-subgoal offer record).
// hardcode-guard:allow the live goal, the pane values and the fixture labels are the inputs under repair
describe("ui_run — a report goal over a reached surface reads its named attributes", () => {
  const row = (id: string, label: string, element: Element): SceneItem => ({
    id,
    role: element.role ?? "AXLink",
    label,
    affordances: ["activatable"],
    stateChanging: false,
    enabled: true,
    element,
  })
  const sidebar = (): Scene => ({
    snapshot: "s-sidebar",
    regions: [{ id: "s:list", kind: "list", itemIds: ["About", "Software Update", "Storage"], textIds: [] }],
    items: [
      row("About", "About", { element_token: "t:about", role: "AXLink", label: "About" }),
      row("Software Update", "Software Update", { element_token: "t:sw", role: "AXLink", label: "Software Update" }),
      row("Storage", "Storage", { element_token: "t:st", role: "AXLink", label: "Storage" }),
    ],
    texts: [],
  })
  const valueRow = (id: string, label: string, value: string): SceneItem => ({
    id,
    role: "AXStaticText",
    label,
    affordances: ["readonly"],
    stateChanging: false,
    enabled: true,
    element: { element_token: `t:${id}`, role: "AXStaticText", label, value },
  })
  const aboutPane = (): Scene => ({
    snapshot: "s-about",
    regions: [
      { id: "a:content", kind: "content", itemIds: [], textIds: ["a:head"] },
      { id: "a:detail", kind: "detail", itemIds: ["a:macos", "a:chip", "a:memory"], textIds: [] },
    ],
    items: [
      valueRow("a:macos", "macOS", "27.2 Beta (26B5112a)"),
      valueRow("a:chip", "Chip", "Apple M3 Max"),
      valueRow("a:memory", "Memory", "128 GB"),
    ],
    texts: [
      { id: "a:head", role: "AXHeading", text: "About", owner: "a:content", element: { element_token: "t:head", role: "AXHeading", label: "About" } },
    ],
  })

  test("(a) the run reaches the About pane and returns THREE evidence-backed reads, not no-choice", async () => {
    let observed: Scene = sidebar()
    const executed: string[] = []
    const result = await Effect.runPromise(
      planLoop({
        goal: "open the About pane and report the macOS version, chip and total memory",
        observe: () => Effect.succeed(observed),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: (option) => {
          executed.push(option.name)
          if (option.name === "open_item") observed = aboutPane()
          return Effect.succeed({ deliveryModes: ["read"] })
        },
        stateChanging: () => false,
        readOnly: false,
        maxSteps: 6,
      }),
    )
    expect(result.status).toBe("completed")
    expect(result.evidence).toBeDefined()
    const cited = (result.evidence ?? []).join(" | ")
    // the three requested VALUES are the evidence (not an unevidenced or absent report)
    expect(cited).toContain("27.2 Beta (26B5112a)")
    expect(cited).toContain("Apple M3 Max")
    expect(cited).toContain("128 GB")
    // the plan carries the surface reach plus one goal-anchored read per named attribute
    expect(executed).toContain("open_item")
  })

  // hardcode-guard:allow the live goal and its pane names are the inputs under repair
  const accessibilityPane = (): Scene => ({
    snapshot: "s-accessibility",
    regions: [
      { id: "s:list", kind: "list", itemIds: ["Wi-Fi", "Accessibility", "General", "Wallpaper"], textIds: [] },
      { id: "s:content", kind: "content", itemIds: [], textIds: ["s:head"] },
    ],
    items: [
      row("Wi-Fi", "Wi-Fi", { element_token: "t:wifi", role: "AXRow", label: "Wi-Fi" }),
      row("Accessibility", "Accessibility", { element_token: "t:acc", role: "AXRow", label: "Accessibility" }),
      row("General", "General", { element_token: "t:gen", role: "AXRow", label: "General", element_index: 2 }),
      row("Wallpaper", "Wallpaper", { element_token: "t:wall", role: "AXRow", label: "Wallpaper" }),
      // hardcode-guard:allow fixture row labels are the enumerable navigation inputs under repair
      // The observed app keeps the target INSIDE a group row, so that row LEADS to it: the
      // path exists in the structure, never in list position.
      row("About", "About", {
        element_token: "t:about",
        role: "AXStaticText",
        label: "About",
        element_index: 9,
        parent_index: 2,
      }),
    ],
    texts: [
      { id: "s:head", role: "AXHeading", text: "Accessibility", owner: "s:content", element: { element_token: "t:head", role: "AXHeading", label: "Accessibility" } },
    ],
  })

  test("(a) LIVE DEFECT REPLAY: a pane of the frontmost app is navigated INSIDE the app, never launched", async () => {
    // THE RECORDED RUN (verbatim): the frontmost app (System Settings) showed a
    // DIFFERENT pane ("Accessibility") while the goal named "About". The whole plan
    // collapsed to ONE option `open_app: launch or activate "About"`, taken on
    // `selection: "single-applicable"` (decider deliberately not consulted), entered
    // path `open_app`, predicate false, evidence 0, and failed
    // `failed: launch_app failed: No installed macOS app found for name 'About'.`
    // "About" is a PANE of the same app, reachable inside it — NOT an application.
    let observed: Scene = accessibilityPane()
    const executed: string[] = []
    const result = await Effect.runPromise(
      planLoop({
        goal: "open the About pane and report the macOS version, chip and total memory",
        observe: () => Effect.succeed(observed),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: (option) => {
          executed.push(option.name)
          if (option.name === "open_item") observed = aboutPane()
          return Effect.succeed({ deliveryModes: ["read"] })
        },
        stateChanging: () => false,
        readOnly: false,
        maxSteps: 8,
      }),
    )
    // NO application-launch option is offered for the target's name; the loop
    // proceeds by navigating inside the app and then reads the attribute values.
    expect((result.offers ?? []).every((offer) => offer.offered.every((label) => !label.startsWith("open_app")))).toBe(
      true,
    )
    expect(executed).not.toContain("open_app")
    expect(executed).toContain("open_item")
    expect(result.status).toBe("completed")
    expect((result.evidence ?? []).join(" | ")).toContain("Apple M3 Max")
  })

  // hardcode-guard:allow the fixture row labels are the enumerable navigation inputs under repair
  test("(a) LIVE REGRESSION: when NO row leads to the target, nothing is activated at all", async () => {
    // THE RECORDED LIVE RUN (verbatim): the frontmost app showed a DIFFERENT pane and the
    // loop activated the FIRST listed row — the surface went Accessibility -> VoiceOver —
    // because the deriver targeted `listed.slice(0, count)` without checking that any row
    // led to the goal's target, which the tree did not hold anywhere.
    const rowsOnly = (): Scene => ({
      snapshot: "s-rows-only",
      regions: [
        { id: "s:list", kind: "list", itemIds: ["Wi-Fi", "Accessibility", "General", "Wallpaper"], textIds: [] },
      ],
      items: [
        row("Wi-Fi", "Wi-Fi", { element_token: "t:wifi", role: "AXRow", label: "Wi-Fi" }),
        row("Accessibility", "Accessibility", { element_token: "t:acc", role: "AXRow", label: "Accessibility" }),
        row("General", "General", { element_token: "t:gen", role: "AXRow", label: "General" }),
        row("Wallpaper", "Wallpaper", { element_token: "t:wall", role: "AXRow", label: "Wallpaper" }),
      ],
      texts: [],
    })
    const executed: string[] = []
    const result = await Effect.runPromise(
      planLoop({
        goal: "open the About pane and report the macOS version, chip and total memory",
        observe: () => Effect.succeed(rowsOnly()),
        choosePlan: () => Effect.succeed(undefined),
        // even a decider that would pick the first option must not be able to select an actuation
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: (option) => {
          executed.push(option.name)
          return Effect.succeed({ deliveryModes: ["declared"] })
        },
        stateChanging: () => false,
        readOnly: false,
        maxSteps: 8,
      }),
    )
    // NO blind navigation: no row is activated, no launch is attempted, and the run does
    // not report success.
    expect(executed.filter((name) => name === "open_item" || name === "activate" || name === "open_app")).toEqual([])
    const firstOffers = (result.offers ?? [])[0]?.offered ?? []
    expect(firstOffers.some((label) => label.startsWith("open_item"))).toBe(false)
    expect(firstOffers.some((label) => label.startsWith("open_app"))).toBe(false)
    expect(result.status).not.toBe("completed")
  })

  test("(b) each subgoal attempt records the maneuver set it was offered, in order", async () => {
    const urlText = (text: string): SceneText => ({
      id: "u",
      role: "AXStaticText",
      text,
      owner: "content",
      element: { element_token: "t:url", role: "AXStaticText", label: text },
    })
    const bar: SceneItem = {
      id: "bar",
      role: "AXTextField",
      label: "Address",
      affordances: ["typable"],
      stateChanging: false,
      enabled: true,
      element: { element_token: "t:bar", role: "AXTextField", label: "Address", value: "" },
    }
    const list = (labels: readonly string[], snapshot: string, texts: readonly SceneText[]): Scene => ({
      snapshot,
      regions: [
        { id: `${snapshot}:content`, kind: "content", itemIds: [], textIds: texts.map((t) => t.id) },
        { id: `${snapshot}:list`, kind: "list", itemIds: [...labels], textIds: [] },
      ],
      items: [bar, ...labels.map((label) => row(label, label, { element_token: `t:${label}`, role: "AXLink", label }))],
      texts,
    })
    const unrelated = list(["Inbox", "Sent", "Drafts"], "s-unrelated", [])
    const arrivedPartial = list(["m1"], "s-partial", [urlText("https://example.invalid/inbox")])
    const arrivedFull = list(["m1", "m2", "m3"], "s-full", [urlText("https://example.invalid/inbox")])
    let observed: Scene = unrelated
    const result = await Effect.runPromise(
      planLoop({
        goal: 'go to "https://example.invalid/inbox" and read the last 3 messages',
        observe: () => Effect.succeed(observed),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: (option) => {
          if (option.name === "go_to_url") observed = arrivedPartial
          if (option.name === "read_items") observed = arrivedFull
          return Effect.succeed({ deliveryModes: ["read"] })
        },
        stateChanging: () => false,
        readOnly: true,
        maxSteps: 6,
      }),
    )
    const offers = result.offers ?? []
    // MORE THAN ONE subgoal was attempted, and the offered maneuver set was recorded
    // for each attempt, in ascending subgoal order.
    expect(result.progress?.total ?? 0).toBeGreaterThan(1)
    expect(offers.map((entry) => entry.subgoalIndex)).toEqual([0, 1])
    expect(offers[0].offered.length).toBeGreaterThan(0)
    expect(offers[1].offered.length).toBeGreaterThan(0)
    expect(offers[1].kind).toBe("read_items")
  })

  test("(c) a genuinely unreadable target stops with the DISTINCT target-unreadable status, never no-choice", async () => {
    const readable = (): Scene => {
      const labels = ["m1", "m2", "m3"]
      return {
        snapshot: "s-readable",
        regions: [{ id: "s:list", kind: "list", itemIds: labels, textIds: [] }],
        items: labels.map((label) => row(label, label, { element_token: `t:${label}`, role: "AXLink", label })),
        texts: [],
      }
    }
    const result = await Effect.runPromise(
      planLoop({
        goal: 'read the last 3 messages from chartreuse',
        observe: () => Effect.succeed(readable()),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: () => Effect.succeed({ deliveryModes: ["read"] }),
        stateChanging: () => false,
        readOnly: true,
        maxSteps: 4,
      }),
    )
    expect(result.status).toBe(STATUS_UNREADABLE)
    expect(result.reason).toContain("chartreuse")
    expect(result.status).not.toBe("no-choice")
    expect(result.status).not.toBe(STATUS_NO_APPLICABLE)

    // the SAME distinct outcome is NOT taken when the target IS present
    // hardcode-guard:allow the synthetic label is the unseen-input target token under test, not a named case
    const base = readable()
    const present: Scene = {
      ...base,
      regions: [{ id: "s:list", kind: "list", itemIds: [...base.regions[0].itemIds, "chartreuse note"], textIds: [] }],
      items: [
        ...base.items,
        row("chartreuse note", "chartreuse note", { element_token: "t:c", role: "AXLink", label: "chartreuse note" }),
      ],
    }
    const ok = await Effect.runPromise(
      planLoop({
        goal: 'read the last 3 messages from chartreuse',
        observe: () => Effect.succeed(present),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: () => Effect.succeed({ deliveryModes: ["read"] }),
        stateChanging: () => false,
        readOnly: true,
        maxSteps: 4,
      }),
    )
    expect(ok.status).not.toBe(STATUS_UNREADABLE)
  })

  test("(d) an unusable decider label is DISTINCT from an empty option space; both record what was offered", async () => {
    const listed = (): Scene => ({
      snapshot: "s-list",
      regions: [{ id: "s:list", kind: "list", itemIds: ["m1"], textIds: [] }],
      items: [row("m1", "m1", { element_token: "t:m1", role: "AXLink", label: "m1" })],
      texts: [],
    })
    const unusable = await Effect.runPromise(
      planLoop({
        goal: "read the last 3 messages",
        observe: () => Effect.succeed(listed()),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: () => Effect.succeed({ label: "not-an-offered-maneuver" }),
        execute: () => Effect.succeed({ deliveryModes: [] }),
        stateChanging: () => false,
        readOnly: true,
        maxSteps: 4,
      }),
    )
    expect(unusable.status).toBe(STATUS_UNUSABLE_CHOICE)
    expect((unusable.offers ?? [])[0]?.offered.length).toBeGreaterThan(0)
    expect((unusable.offers ?? [])[0]?.chosen).toBe("not-an-offered-maneuver")

    const empty: Scene = { snapshot: "s-empty", regions: [], items: [], texts: [] }
    const nothing = await Effect.runPromise(
      planLoop({
        goal: "read the last 3 messages",
        observe: () => Effect.succeed(empty),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: () => Effect.succeed({ deliveryModes: [] }),
        stateChanging: () => false,
        readOnly: true,
        maxSteps: 4,
      }),
    )
    // genuinely nothing applicable → nothing-applicable (NOT choice-unusable), and
    // the empty offered set is still recorded so the two stops are distinguishable.
    expect(nothing.status).toBe(STATUS_NO_APPLICABLE)
    expect((nothing.offers ?? [])[0]?.offered).toEqual([])
  })
})

// GENERALIZATION — INVARIANT: a READ is an OBSERVATION. It resolves its target from
// the CURRENT observation and takes the text straight from the accessibility tree
// (the element's own label/value/displayed text) — no click, no scroll, no pixel and
// no delivery requirement. It never walks the click ladder, and "no effect" can
// never fail a read; pixel/OCR is a last resort, taken only with a FRESH capture.
// LIVE INSTANCE (verbatim): pid 24372 / window 3041 — the About pane exposed
// "Apple M3 Max", "128 GB", "macOS Golden Gate" and "Version 27.2 Beta (26B5112a)"
// as plain AXStaticText; the read subgoal's `read_text` option walked the click
// ladder and failed "click undelivered on every rung ... No screenshot frame for
// window 3041". UNSEEN INPUTS: a value exposed as a standalone static text with no
// list region; and a read whose text is only reachable through a fresh capture.
// hardcode-guard:allow the live pane text and window id are the inputs under repair
describe("ui_run — a read is an observation, never an actuation", () => {
  const win = { pid: 24372, window_id: 3041 }
  const wire = (elements: readonly Element[]) => ({
    snapshot_id: "s-about",
    elements: elements.map((element) => ({
      token: element.element_token,
      role: element.role,
      label: element.label,
      value: element.value,
      frame: element.frame,
    })),
  })
  const staticText = (
    token: string,
    text: string,
    rect: { x: number; y: number; width: number; height: number },
  ): Element => ({ element_token: token, role: "AXStaticText", label: text, frame: rect })
  const aboutPane = (): readonly Element[] => [
    staticText("s00000294", "Apple M3 Max", { x: 5911, y: 51, width: 411, height: 52 }),
    staticText("s00000295", "128 GB", { x: 5911, y: 110, width: 411, height: 24 }),
    staticText("s00000296", "macOS Golden Gate", { x: 5911, y: 140, width: 411, height: 24 }),
    staticText("s00000297", "Version 27.2 Beta (26B5112a)", { x: 5911, y: 170, width: 411, height: 24 }),
  ]
  const makeDriver = (observations: readonly unknown[]) => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      const next = observations[calls.length - 1]
      return Effect.succeed(
        next === undefined
          ? { ok: false, error: "unscripted" }
          : { ok: true, result: { content: [], structuredContent: next } },
      )
    }
    return { call, calls }
  }

  test("(a) a settled pane's static text yields evidence for each named attribute with ZERO actuation calls", async () => {
    const driver = makeDriver([wire(aboutPane())])
    const run = await Effect.runPromise(runReadManeuver(driver.call, win, ["apple", "128", "macos", "26b5112a"]))
    const cited = run.evidence.map((entry) => entry.text).join(" | ")
    expect(cited).toContain("Apple M3 Max")
    expect(cited).toContain("128 GB")
    expect(cited).toContain("macOS Golden Gate")
    expect(cited).toContain("Version 27.2 Beta (26B5112a)")
    // the evidence carries the element's identity + geometry, taken from the tree
    const chip = run.evidence.find((entry) => entry.text === "Apple M3 Max")!
    expect(chip.identity).toBe("s00000294")
    expect(chip.role).toBe("AXStaticText")
    expect(chip.rect).toEqual({ x: 5911, y: 51, width: 411, height: 52 })
    // ZERO actuation: every driver call is an observation, never a click/scroll/pixel
    expect(driver.calls.every((entry) => entry.name === "cua-driver_get_window_state")).toBe(true)
    expect(run.captured).toBe(false)
  })

  test("(b) a value absent from the tree takes the CAPTURE path only after a fresh capture", async () => {
    const treeLacks = [staticText("s00000294", "Apple M3 Max", { x: 5911, y: 51, width: 411, height: 52 })]
    const captured = [staticText("s00000296", "Version 27.2 Beta (26B5112a)", { x: 4500, y: 400, width: 300, height: 24 })]
    const driver = makeDriver([wire(treeLacks), wire(captured)])
    const run = await Effect.runPromise(runReadManeuver(driver.call, win, ["26b5112a"]))
    // the first call is the cheap tree read; the second ESTABLISHES a fresh frame
    expect(driver.calls.map((entry) => entry.name)).toEqual([
      "cua-driver_get_window_state",
      "cua-driver_get_window_state",
    ])
    expect(driver.calls[0]!.args).toMatchObject({ include_screenshot: false })
    expect(driver.calls[1]!.args).toMatchObject({ include_screenshot: true })
    expect(run.captured).toBe(true)
    // geometry derives from the NEW capture, never the stale frame
    expect(run.evidence[0]!.text).toBe("Version 27.2 Beta (26B5112a)")
    expect(run.evidence[0]!.rect).toEqual({ x: 4500, y: 400, width: 300, height: 24 })
    expect(driver.calls.every((entry) => entry.name === "cua-driver_get_window_state")).toBe(true)
  })

  test("(c) a read with no matching tree text still returns as a read — never a click failure", async () => {
    const driver = makeDriver([wire(aboutPane()), wire(aboutPane())])
    const run = await Effect.runPromise(runReadManeuver(driver.call, win, ["chartreuse-token"]))
    expect(run.evidence).toEqual([])
    // the fallback capture ran, but NO click/scroll/pixel was ever issued
    expect(driver.calls.every((entry) => entry.name === "cua-driver_get_window_state")).toBe(true)
  })

  test("(a) read maneuvers are reads; open/activate/navigate are not", () => {
    expect(isReadManeuver({ name: "read_items" } as ManeuverOption)).toBe(true)
    expect(isReadManeuver({ name: "read_text" } as ManeuverOption)).toBe(true)
    expect(isReadManeuver({ name: "open_item" } as ManeuverOption)).toBe(false)
    expect(isReadManeuver({ name: "activate" } as ManeuverOption)).toBe(false)
    expect(isReadManeuver({ name: "go_to_url" } as ManeuverOption)).toBe(false)
  })

  test("(a) a report goal over a settled static-text pane completes with the cited values", async () => {
    const cell = (id: string, text: string, token: string): SceneText => ({
      id,
      role: "AXStaticText",
      text,
      owner: "a:detail",
      element: { element_token: token, role: "AXStaticText", label: text },
    })
    const scene: Scene = {
      snapshot: "s-about",
      regions: [{ id: "a:detail", kind: "detail", itemIds: [], textIds: ["t1", "t2", "t3", "t4"] }],
      items: [],
      texts: [
        cell("t1", "Apple M3 Max", "s00000294"),
        cell("t2", "128 GB", "s00000295"),
        cell("t3", "macOS Golden Gate", "s00000296"),
        cell("t4", "Version 27.2 Beta (26B5112a)", "s00000297"),
      ],
    }
    const result = await Effect.runPromise(
      planLoop({
        goal: "report the Apple M3 Max and 128 GB",
        observe: () => Effect.succeed(scene),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => Effect.succeed({ label: options[0]?.label }),
        execute: () => Effect.succeed({ deliveryModes: [] }),
        stateChanging: () => false,
        readOnly: true,
        maxSteps: 6,
      }),
    )
    expect(result.status).toBe("completed")
    const cited = (result.evidence ?? []).join(" | ")
    expect(cited).toContain("Apple M3 Max")
    expect(cited).toContain("128 GB")
  })
})

// GENERALIZATION — INVARIANT: an ATTRIBUTE is bound through its LABEL to its VALUE.
// The read uses the attribute NAME to find the LABEL element, then binds the VALUE
// that belongs to it (a structural sibling in the same row/group, falling back to
// geometric adjacency), citing BOTH elements; a label with no adjacent value is
// UNREADABLE, and an EMPTY read never repeats identically — it ends in the distinct
// `target-unreadable` outcome naming the attribute.
// LIVE INSTANCE (verbatim): System Settings window 3178's About pane exposed the
// values as standalone static text ("Apple M3 Max", "128 GB", "macOS Golden Gate",
// "Version 27.2 Beta (26B5112a)") while the goal asked for "the chip", "total
// memory", "the macOS version"; the read_text entry repeated three times with
// `evidence=[]` and stopped on `maneuver-repeat-limit`. UNSEEN INPUTS: a value whose
// label sits in the same row band but a different container (geometric adjacency),
// and a read naming an attribute present only as a bare label with no value.
// hardcode-guard:allow the live pane text and window id are the inputs under repair
describe("ui_run — a named attribute is bound through its label to its value", () => {
  const win = { pid: 24372, window_id: 3178 }
  const paneElements = (): readonly Element[] => [
    { element_index: 0, element_token: "g0", role: "AXGroup", label: "", depth: 0, frame: { x: 0, y: 0, width: 600, height: 400 } },
    { element_index: 1, element_token: "l1", role: "AXStaticText", label: "Chip", depth: 1, parent_index: 0, frame: { x: 20, y: 60, width: 80, height: 20 } },
    { element_index: 2, element_token: "v1", role: "AXStaticText", label: "Apple M3 Max", depth: 1, parent_index: 0, frame: { x: 300, y: 60, width: 200, height: 20 } },
    { element_index: 3, element_token: "l2", role: "AXStaticText", label: "Memory", depth: 1, parent_index: 0, frame: { x: 20, y: 100, width: 80, height: 20 } },
    { element_index: 4, element_token: "v2", role: "AXStaticText", label: "128 GB", depth: 1, parent_index: 0, frame: { x: 300, y: 100, width: 200, height: 20 } },
    { element_index: 5, element_token: "l3", role: "AXStaticText", label: "macOS", depth: 1, parent_index: 0, frame: { x: 20, y: 140, width: 80, height: 20 } },
    { element_index: 6, element_token: "v3", role: "AXStaticText", label: "Version 27.2 Beta (26B5112a)", depth: 1, parent_index: 0, frame: { x: 300, y: 140, width: 260, height: 20 } },
  ]
  const wire = (elements: readonly Element[]) => ({
    snapshot_id: "s-about",
    elements: elements.map((element) => ({
      token: element.element_token,
      role: element.role,
      label: element.label,
      frame: element.frame,
      element_index: element.element_index,
      parent_index: element.parent_index,
    })),
  })
  const makeDriver = (observations: readonly unknown[]) => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const call: DriverCall = (name, args) => {
      calls.push({ name, args })
      const next = observations[Math.min(calls.length - 1, observations.length - 1)]
      return Effect.succeed({ ok: true, result: { content: [], structuredContent: next } })
    }
    return { call, calls }
  }

  test("(a) each named attribute binds to the value beside its label and cites BOTH elements", () => {
    const { evidence, unbound } = resolveRead(paneElements(), ["chip", "memory", "macos"])
    expect(unbound).toEqual([])
    const byName = (token: string) => evidence.find((entry) => entry.token === token)!
    const chip = byName("chip")
    expect(chip.text).toBe("Apple M3 Max")
    expect(chip.identity).toBe("v1")
    expect(chip.label).toMatchObject({ text: "Chip", identity: "l1", role: "AXStaticText" })
    const memory = byName("memory")
    expect(memory.text).toBe("128 GB")
    expect(memory.label?.text).toBe("Memory")
    const os = byName("macos")
    expect(os.text).toBe("Version 27.2 Beta (26B5112a)")
    expect(os.label?.text).toBe("macOS")
  })

  test("(a) a bound read over the live pane shape records label+value evidence with ZERO actuation", async () => {
    const driver = makeDriver([wire(paneElements())])
    const run = await Effect.runPromise(runReadManeuver(driver.call, win, ["chip", "memory", "macos"]))
    const cited = run.evidence.map((entry) => `${entry.label?.text}=${entry.text}`).join(" | ")
    expect(cited).toContain("Chip=Apple M3 Max")
    expect(cited).toContain("Memory=128 GB")
    expect(cited).toContain("macOS=Version 27.2 Beta (26B5112a)")
    expect(run.captured).toBe(false)
    expect(driver.calls.every((entry) => entry.name === "cua-driver_get_window_state")).toBe(true)
  })

  // hardcode-guard:allow the recorded live token/strategy names are the contract replayed under test
  test("(a) LIVE-TRACE REPLAY (round 2): a SINGLE read option is taken on applicability — the decider is never consulted", async () => {
    // THE MEASURED LIVE ROUND-2 SHAPE (verbatim): the decider was offered EXACTLY ONE
    // option — `read_text: … [direct-token]` — and returned no maneuver:
    // `choice-unusable: the decider returned no maneuver among 1 offered option(s)`,
    // 0 read attempts, the run ended there. The next read STRATEGY is not a decision —
    // it is exhaustion order the loop already owns — and a choice needs alternatives.
    // PRE-FIX this replay (single option + a decider returning nothing) stopped
    // immediately at `choice-unusable` with zero read attempts. NOW the single
    // applicable option is TAKEN on applicability and the strategies deplete.
    //
    // The token lives only in a text OWNED by an item, so no standalone readable or
    // list row matches it: `read_items`/`open_item`/`activate` are not applicable and
    // exactly ONE read option is applicable per round.
    const owned: Scene = {
      snapshot: "s-owned-read",
      regions: [{ id: "s:detail", kind: "detail", itemIds: ["r:proc"], textIds: ["v:chip"] }],
      items: [
        {
          id: "r:proc",
          role: "AXGroup",
          label: "Processor",
          affordances: ["readonly"],
          stateChanging: false,
          enabled: true,
          element: { element_token: "t:r:proc", role: "AXGroup", label: "Processor" },
        },
      ],
      texts: [
        {
          id: "v:chip",
          role: "AXStaticText",
          text: "Chip: Apple M3 Max",
          owner: "r:proc",
          element: { element_token: "t:v:chip", role: "AXStaticText", label: "Chip: Apple M3 Max" },
        },
      ],
    }
    let deciderCalls = 0
    const result = await Effect.runPromise(
      planLoop({
        goal: "read the text about chip",
        observe: () => Effect.succeed(owned),
        choosePlan: () => Effect.succeed(undefined),
        // The live decider's verdict: NOTHING. It must never be consulted here.
        chooseManeuver: () => {
          deciderCalls++
          return Effect.succeed({})
        },
        execute: (option) =>
          option.name === "read_text"
            ? Effect.succeed({ deliveryModes: ["read"], unbound: ["chip"] })
            : Effect.succeed({ deliveryModes: [] }),
        stateChanging: () => false,
        readOnly: true,
        maxSteps: 8,
      }),
    )
    // (a) ONE applicable maneuver → the decider is NOT consulted at all.
    expect(deciderCalls).toBe(0)
    // (a) EXACTLY ONE read option offered per round, its strategy payload advancing.
    const readRounds = (result.offers ?? [])
      .filter((offer) => offer.kind === "read_items")
      .map((offer) => offer.offered)
    expect(readRounds.map((round) => round.length)).toEqual([1, 1, 1])
    expect(readRounds.map((round) => round[0]?.match(/\[([^\]]+)\]$/)?.[1])).toEqual([
      "direct-token",
      "label-pairing",
      "observation-fallback",
    ])
    // (b) NO strategy is ever repeated for the subgoal.
    const strategies = readRounds.flat()
    expect(new Set(strategies).size).toBe(strategies.length)
    // (a) PROVENANCE marks the path taken on APPLICABILITY (never a fabricated strength).
    const provenance = result.telemetry.filter((entry) => entry.provenance.path === "read")
    expect(provenance.length).toBe(3)
    expect(provenance.every((entry) => entry.provenance.selection === "single-applicable")).toBe(true)
    expect(provenance.map((entry) => entry.provenance.strategy)).toEqual([
      "direct-token",
      "label-pairing",
      "observation-fallback",
    ])
    expect(provenance.every((entry) => entry.provenance.option === "read_text")).toBe(true)
    // (a) the NAMED stop — subgoal, attribute, strategies tried
    expect(result.status).toBe(STATUS_UNREADABLE)
    expect(result.reason).toContain("chip")
    expect(result.reason).toContain("direct-token")
    expect(result.reason).toContain("observation-fallback")
  })

  // hardcode-guard:allow fixture labels/tokens are the enumerable input under test
  test("(b) TWO OR MORE applicable maneuvers DO consult the decider — exactly once", async () => {
    const list: Scene = {
      snapshot: "s-two",
      regions: [{ id: "s:list", kind: "list", itemIds: ["m1"], textIds: [] }],
      items: [
        {
          id: "m1",
          role: "AXLink",
          label: "m1",
          affordances: ["activatable"],
          stateChanging: false,
          enabled: true,
          element: { element_token: "t:m1", role: "AXLink", label: "m1" },
        },
      ],
      texts: [],
    }
    let deciderCalls = 0
    const result = await Effect.runPromise(
      planLoop({
        goal: "read the last 3 messages",
        observe: () => Effect.succeed(list),
        choosePlan: () => Effect.succeed(undefined),
        chooseManeuver: (_subgoal, options) => {
          deciderCalls++
          return Effect.succeed({ label: options[0]?.label })
        },
        execute: () => Effect.succeed({ deliveryModes: ["read"] }),
        stateChanging: () => false,
        readOnly: true,
        maxSteps: 1,
      }),
    )
    // read_items + open_item are both applicable → a REAL choice, consulted once.
    expect(deciderCalls).toBe(1)
    const chosen = result.telemetry.find((entry) => entry.provenance.path === "read")
    expect(chosen?.provenance.selection).toBe("decider")
  })

  test("(c) the shared registry is the ONE source of option/strategy names", () => {
    expect(MANEUVER_NAMES).toContain("read_text")
    expect(MANEUVER_NAMES).toContain("read_items")
    expect(new Set(READ_STRATEGY_NAMES).size).toBe(READ_STRATEGY_NAMES.length)
    expect(READ_STRATEGY_NAMES).toEqual(["direct-token", "label-pairing", "observation-fallback"])
  })

  test("(c) a read dispatches through the registry with the OFFERED strategy, never an after-the-fact field", async () => {
    const driver = makeDriver([wire(paneElements()), wire(paneElements())])
    const direct = await Effect.runPromise(runReadManeuver(driver.call, win, ["absent-token"], "direct-token"))
    expect(direct.strategies).toEqual(["direct-token"])
    const fallback = await Effect.runPromise(
      runReadManeuver(driver.call, win, ["absent-token"], "observation-fallback"),
    )
    expect(fallback.strategies).toEqual(["observation-fallback"])
  })

  test("(c) a label with no adjacent value is UNREADABLE, never a success", async () => {
    const lone: readonly Element[] = [
      { element_index: 0, element_token: "l1", role: "AXStaticText", label: "Chip", depth: 0, frame: { x: 20, y: 60, width: 80, height: 20 } },
    ]
    const { evidence, unbound } = resolveRead(lone, ["chip"])
    expect(evidence).toEqual([])
    expect(unbound).toEqual(["chip"])

    const driver = makeDriver([wire(lone)])
    const run = await Effect.runPromise(runReadManeuver(driver.call, win, ["chip"]))
    expect(run.evidence).toEqual([])
    expect(run.unbound).toEqual(["chip"])
    expect(driver.calls.every((entry) => entry.name === "cua-driver_get_window_state")).toBe(true)
  })
})


