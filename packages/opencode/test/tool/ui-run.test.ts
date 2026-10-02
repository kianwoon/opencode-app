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
import { CONTROLS_MAX, LABEL_MAX } from "@/jev/controller"
import { Parameters, UiRunTool, buildCandidates, decodeObservation } from "@/tool/ui-run"
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
    expect(decoded.value.steps.length).toBe(1)
    expect(decoded.value.window.window_id).toBe(7)
    expect(decoded.value.expect).toBeUndefined()
  })

  test("decodes a fill step carrying a value", () => {
    const decoded = Schema.decodeUnknownOption(Parameters)({
      goal: "search",
      window,
      steps: [{ intent: "focus the search field" }, { intent: "type the query", value: "jev" }],
    })

    expect(decoded._tag).toBe("Some")
    if (decoded._tag !== "Some") return
    expect(decoded.value.steps[1].value).toBe("jev")
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