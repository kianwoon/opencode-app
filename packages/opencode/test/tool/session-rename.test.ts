import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session as SessionNs } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { SessionRenameTool } from "@/tool/session-rename"
import { MessageID, SessionID } from "@/session/schema"
import { provideInstance, provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Truncate.node,
      Agent.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    ],
  ),
)

const toolContext = (sessionID: SessionID): Tool.Context => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("session_rename tool", () => {
  it.instance("renames the session through the real Session service", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "before" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      const tool = yield* Tool.init(yield* SessionRenameTool)
      expect(tool.id).toBe("session_rename")

      const result = yield* tool.execute({ title: "renamed by tool" }, toolContext(created.id))

      expect(result.output).toBe("renamed by tool")
      const after = yield* session.get(created.id)
      expect(after.title).toBe("renamed by tool")
    }),
  )

  it.instance("rejects subagent rename without changing the child", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const parent = yield* session.create({ title: "root" })
      const child = yield* session.create({ parentID: parent.id, title: "child before", agent: "explore" })
      const tool = yield* Tool.init(yield* SessionRenameTool)

      const exit = yield* Effect.exit(tool.execute({ title: "renamed child" }, toolContext(child.id)))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.prettyErrors(exit.cause).map(String).join("\n")).toContain("subagent")
      }
      expect((yield* session.get(child.id)).title).toBe("child before")
    }),
  )

  it.instance(
    "rejects rename for a session from another real project",
    () =>
      Effect.gen(function* () {
        const currentInstance = yield* TestInstance
        const session = yield* SessionNs.Service
        const current = yield* session.create({ title: "current" })

        const foreign = yield* provideTmpdirInstance(
          (foreignDirectory) =>
            Effect.gen(function* () {
              expect(foreignDirectory).not.toBe(currentInstance.directory)
              const sessions = yield* SessionNs.Service
              const foreignSession = yield* sessions.create({ title: "foreign" })
              const observed = yield* provideInstance(currentInstance.directory)(sessions.get(foreignSession.id))
              const tool = yield* Tool.init(yield* SessionRenameTool)
              const exit = yield* Effect.exit(
                provideInstance(currentInstance.directory)(
                  tool.execute({ title: "cross-project" }, toolContext(foreignSession.id)),
                ),
              )
              const after = yield* sessions.get(foreignSession.id)
              return { foreignSession, observed, exit, after }
            }),
          { git: true },
        )

        expect(foreign.observed.projectID).toBe(foreign.foreignSession.projectID)
        expect(foreign.foreignSession.projectID).not.toBe(current.projectID)
        expect(Exit.isFailure(foreign.exit)).toBe(true)
        if (Exit.isFailure(foreign.exit)) {
          expect(Cause.prettyErrors(foreign.exit.cause).map(String).join("\n")).toContain("active project")
        }
        expect(foreign.after.title).toBe("foreign")
      }),
    { git: true },
  )
})
