import { afterEach, expect } from "bun:test"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Snapshot.node, EventV2Bridge.node, FSUtil.node])),
    testInstanceStoreLayer,
  ),
)

// Windows path parity with snapshot.test.ts expectations.
const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")

afterEach(async () => {
  await disposeAllInstances()
})

const write = (file: string, content: string) => FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))

const bootstrap = Effect.fn("SnapshotDirtyTest.bootstrap")(function* () {
  const tmp = yield* TestInstance
  const unique = Math.random().toString(36).slice(2)
  const aContent = `A${unique}`
  yield* write(`${tmp.directory}/a.txt`, aContent)
  yield* write(`${tmp.directory}/b.txt`, `B${unique}`)
  return { directory: tmp.directory, aContent }
})

const publishChange = Effect.fn("SnapshotDirtyTest.publishChange")(function* (file: string) {
  const events = yield* EventV2Bridge.Service
  yield* events.publish(Watcher.Event.Updated, { file, event: "change" })
})

// Poll patch() until every mustHave file shows up and none of mustNotHave does.
// The mustNotHave list is what makes the dirty path observable: a full scan would
// reveal un-watched modifications, a dirty-scoped pass cannot.
const patchConverged = Effect.fn("SnapshotDirtyTest.patchConverged")(function* (
  snapshot: Snapshot.Interface,
  before: string,
  mustHave: string[],
  mustNotHave: string[] = [],
) {
  return yield* pollWithTimeout(
    Effect.gen(function* () {
      const patch = yield* snapshot.patch(before)
      const ok =
        mustHave.every((file) => patch.files.includes(file)) && mustNotHave.every((file) => !patch.files.includes(file))
      return ok ? patch : undefined
    }),
    `patch never converged: want [${mustHave.join(", ")}] to exclude [${mustNotHave.join(", ")}]`,
  )
})

it.instance(
  "stages only watcher-reported files while dirty tracking is active",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()

    // Change a tracked-by-snapshot file WITHOUT publishing an event, and create a
    // new file WITH an event. Only the evented file may appear in the patch.
    yield* write(`${tmp.directory}/a.txt`, `${tmp.aContent} modified`)
    const created = fwd(tmp.directory, "new.txt")
    yield* write(created, "NEW")
    yield* publishChange(created)

    const patch = yield* patchConverged(snapshot, before!, [created], [fwd(tmp.directory, "a.txt")])
    expect(patch.files).toContain(created)
    expect(patch.files).not.toContain(fwd(tmp.directory, "a.txt"))
    expect(patch.files).not.toContain(fwd(tmp.directory, "b.txt"))
  }),
  { git: true },
)

it.instance(
  "periodic full scan reveals un-watched changes after repeated dirty passes",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()

    // Un-watched modification that must stay invisible while the dirty path runs.
    yield* write(`${tmp.directory}/a.txt`, `${tmp.aContent} modified`)
    const watched = fwd(tmp.directory, "a.txt")

    // fullScanInterval is 10: the first nine dirty-scoped passes hide the change.
    for (let i = 1; i <= 9; i++) {
      const file = fwd(tmp.directory, `chg-${i}.txt`)
      yield* write(file, `CHG${i}`)
      yield* publishChange(file)
      const patch = yield* patchConverged(snapshot, before!, [file], [watched])
      expect(patch.files).toContain(file)
    }

    // The tenth dirty pass forces a full scan, which picks up a.txt too.
    const tenth = fwd(tmp.directory, "chg-10.txt")
    yield* write(tenth, "CHG10")
    yield* publishChange(tenth)
    const patch = yield* patchConverged(snapshot, before!, [tenth, watched])
    expect(patch.files).toContain(tenth)
    expect(patch.files).toContain(watched)
  }),
  { git: true },
)

it.instance(
  "events for deleted files stage deletions through the dirty path",
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()

    const target = fwd(tmp.directory, "b.txt")
    yield* FSUtil.Service.use((fs) => fs.remove(`${tmp.directory}/b.txt`, { force: true }))
    yield* publishChange(target)

    const patch = yield* patchConverged(snapshot, before!, [target])
    expect(patch.files).toContain(target)
  }),
  { git: true },
)
