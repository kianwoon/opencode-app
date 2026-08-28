import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { BackgroundJob } from "../../src/background/job"
import { Database } from "@opencode-ai/core/database/database"
import { JobRecord } from "@opencode-ai/core/job-record"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const layer = () =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      BackgroundJob.node,
    ]),
  )

const it = testEffect(layer())

describe("background job durable record", () => {
  it.instance(
    "records lifecycle transitions that survive a registry reset, and sweeps stale running rows",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const info = yield* jobs.start({
          type: "test",
          title: "recorded job",
          run: Effect.succeed("done"),
        })
        const waited = yield* jobs.wait({ id: info.id })
        expect(waited.info?.status).toBe("completed")

        // The record exists even though the live entry may later vanish.
        const database = yield* Database.Service
        const ops = JobRecord.provided(database)
        const recorded = yield* ops.get(info.id)
        expect(recorded?.status).toBe("completed")
        expect(recorded?.output).toBe("done")

        // Simulate a crash: mark a fresh job running in the record only.
        yield* ops.record({
          id: "job_ghost",
          type: "test",
          status: "running",
          started_at: Date.now() - 1000,
        })
        const swept = yield* ops.sweepStale()
        expect(swept).toContain("job_ghost")
        const ghost = yield* ops.get("job_ghost")
        expect(ghost?.status).toBe("cancelled")
        expect(ghost?.error).toContain("interrupted by restart")

        // list merges live + recorded history.
        const all = yield* jobs.list()
        expect(all.some((job) => job.id === info.id)).toBe(true)
        expect(all.some((job) => job.id === "job_ghost")).toBe(true)
      }),
    { timeout: 30_000 },
  )
})
