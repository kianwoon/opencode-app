import { expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { ConfigAgent } from "../../src/config/agent"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, AgentSvc.node])))

it.instance(
  "agent color parsed from project config",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.use.get()
      expect(cfg.agent?.["build"]?.color).toBe("#FFA500")
      expect(cfg.agent?.["plan"]?.color).toBe("primary")
    }),
  {
    git: true,
    config: {
      agent: {
        build: { color: "#FFA500" },
        plan: { color: "primary" },
      },
    },
  },
)

it.instance(
  "agent origin distinguishes md-backed, config-only and built-in agents",
  () =>
    Effect.gen(function* () {
      // ConfigAgent.load is where the marker is attached, so assert it there
      // (real implementation, no mocks) and assert the runtime derivation
      // through Agent for the two non-md cases.
      const instance = yield* TestInstance
      const loaded = yield* Effect.promise(() => ConfigAgent.load(instance.directory))
      expect(loaded.scout?.origin).toBe("md")
      const helper = yield* AgentSvc.use.get("helper")
      expect(helper?.origin).toBe("config")
      const plan = yield* AgentSvc.use.get("plan")
      expect(plan?.origin).toBe("native")
    }),
  {
    git: true,
    config: { agent: { helper: { description: "Config-only helper", mode: "subagent" } } },
    init: (directory) =>
      Effect.promise(() =>
        Bun.write(
          path.join(directory, "agent", "scout.md"),
          "---\ndescription: Md-backed scout\nmode: subagent\n---\n\nYou scout.\n",
        ),
      ),
  },
)

it.instance(
  "Agent.get includes color from config",
  () =>
    Effect.gen(function* () {
      const plan = yield* AgentSvc.use.get("plan")
      expect(plan?.color).toBe("#A855F7")
      const build = yield* AgentSvc.use.get("build")
      expect(build?.color).toBe("accent")
    }),
  {
    git: true,
    config: {
      agent: {
        plan: { color: "#A855F7" },
        build: { color: "accent" },
      },
    },
  },
)
