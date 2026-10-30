import { describe, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { LocationMutation } from "../src/location-mutation"
import { Permission } from "../src/permission"
import { Session } from "../src/session"
import { Task } from "../src/task"
import { Tool } from "../src/tool"
import { ScheduleTaskTool } from "../src/tool/schedule-task"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_schedule_task_tool_test")
const assertions: Permission.AssertInput[] = []
let deny = false

const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(
        deny
          ? Effect.fail(
              new Permission.BlockedError({
                rules: [],
                permission: input.action,
                resources: input.resources,
              }),
            )
          : Effect.void,
      ),
    ),
})

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-task-"))
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make(directory),
    workspaceID: undefined,
    projectDirectory: AbsolutePath.make(directory),
    vcs: undefined,
  } as never),
)

const created: (typeof Task.CreateInput.Type)[] = []
const tasks = Layer.mock(Task.Service, {
  create: (input) => {
    created.push(input)
    return Effect.succeed({ id: Task.ID.make("tsk_test"), ...input } as never)
  },
})
const mutation = Layer.mock(LocationMutation.Service, {
  resolve: () => Effect.succeed({ absolute: directory, canonical: directory } as never),
})

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(Tool.node, [Location.node.replace(locationLayer), Permission.node.replace(permission)]),
    tasks,
    mutation,
  ),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  created.length = 0
  deny = false
  yield* registerToolPlugin(ScheduleTaskTool.Plugin).pipe(Effect.provide(permission))
  return { registry: yield* Tool.Service, directory }
})

const call = (input: typeof ScheduleTaskTool.Input.Type, id = "call-schedule-task") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: ScheduleTaskTool.name, input },
})

describe("ScheduleTaskTool", () => {
  it.live("registers and creates a task for the current directory", () =>
    Effect.gen(function* () {
      const { registry } = yield* setup

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([ScheduleTaskTool.name, "execute"])

      const result = yield* executeTool(registry, call({ title: "Nightly", prompt: "run checks", cron: "daily" }))

      expect(result.status).toBe("completed")
      expect(result.output).toMatchObject({ taskID: "tsk_test" })
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({
        title: "Nightly",
        prompt: { text: "run checks" },
        cron: "0 0 * * *",
        directory,
      })
      expect(assertions).toMatchObject([{ sessionID, action: "schedule_task", resources: ["*"], save: ["*"] }])
    }),
  )

  it.live("rejects invalid cron with a tool error", () =>
    Effect.gen(function* () {
      const { registry } = yield* setup

      const result = yield* executeTool(
        registry,
        call({ title: "Broken", prompt: "never fires", cron: "not a schedule" }),
      )
      expect(result.status).toBe("error")
      expect(created).toHaveLength(0)
    }),
  )

  it.live("does not create a task when permission is denied", () =>
    Effect.gen(function* () {
      const { registry } = yield* setup
      deny = true

      const result = yield* executeTool(registry, call({ title: "Blocked", prompt: "nope", cron: "hourly" }))
      expect(result.status).toBe("error")
      expect(created).toHaveLength(0)
    }),
  )
})
