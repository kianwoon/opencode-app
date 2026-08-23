import { expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([EventV2Bridge.node, SessionStatus.node, CrossSpawnSpawner.node])),
)

const sid = SessionID.make("ses_test-gc-1")
const sid2 = SessionID.make("ses_test-gc-2")

it.live(
  "idle GC fires once after the last busy session goes idle, and only after the debounce",
  () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service

      const calls: string[] = []
      const original = Bun.gc
      ;(Bun as unknown as { gc: (force?: boolean) => void }).gc = (force?: boolean) => {
        calls.push(force ? "full-sync" : "full-async")
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          ;(Bun as unknown as { gc: typeof Bun.gc }).gc = original
        }),
      )

      yield* provideTmpdirInstance(() =>
        Effect.gen(function* () {
          yield* status.set(sid, { type: "busy" })
          yield* status.set(sid2, { type: "busy" })
          // One session still busy: no process-idle transition.
          yield* status.set(sid, { type: "idle" })
          yield* Effect.sleep(50)
          // Last busy session goes idle: debounce starts.
          yield* status.set(sid2, { type: "idle" })

          // Before the 5s debounce elapses: nothing collected.
          yield* Effect.sleep(200)
          expect((yield* status.list()).size).toBe(0)

          // Wait past the debounce (real timers; Bun.gc is spied so no pause).
          yield* Effect.sleep(5_300)
        }),
      )

      expect(calls).toEqual(["full-async"])
    }),
  20_000,
)

it.live("busy activity cancels the scheduled idle GC", () =>
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service

    const calls: string[] = []
    const original = Bun.gc
    ;(Bun as unknown as { gc: (force?: boolean) => void }).gc = (force?: boolean) => {
      calls.push(force ? "full-sync" : "full-async")
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ;(Bun as unknown as { gc: typeof Bun.gc }).gc = original
      }),
    )

    yield* provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* status.set(sid, { type: "busy" })
        yield* status.set(sid, { type: "idle" })
        // New work arrives inside the debounce window.
        yield* Effect.sleep(200)
        yield* status.set(sid, { type: "busy" })
        yield* Effect.sleep(5_300)
        yield* status.set(sid, { type: "idle" })
        yield* Effect.sleep(5_300)
      }),
    )

    // Canceled during the busy window, fired once for the final idle —
    // never during busy.
    expect(calls).toEqual(["full-async"])
  }),
  20_000,
)

test("set/list/get track busy sessions", async () => {
  const layer = LayerNode.compile(
    LayerNode.group([EventV2Bridge.node, SessionStatus.node, CrossSpawnSpawner.node]),
  )
  const runtime = ManagedRuntime.make(layer)
  await runtime.runPromise(
    Effect.scoped(provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const status = yield* SessionStatus.Service
        yield* status.set(sid, { type: "busy" })
        expect((yield* status.get(sid)).type).toBe("busy")
        expect((yield* status.list()).size).toBe(1)
        yield* status.set(sid, { type: "idle" })
        expect((yield* status.get(sid)).type).toBe("idle")
        expect((yield* status.list()).size).toBe(0)
      }),
    )),
  )
  await runtime.dispose()
})

