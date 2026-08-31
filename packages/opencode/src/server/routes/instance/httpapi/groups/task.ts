import { Task } from "@opencode-ai/core/task"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { TaskNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/task"

export const TaskPaths = {
  list: root,
  get: `${root}/:taskID`,
  runs: `${root}/:taskID/runs`,
  run: `${root}/:taskID/run`,
} as const

export const TaskApi = HttpApi.make("task").add(
  HttpApiGroup.make("task")
    .add(
      HttpApiEndpoint.get("list", TaskPaths.list, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(Task.Info), "List of scheduled tasks"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task.list",
          summary: "List scheduled tasks",
          description: "Get every scheduled task known to the scheduler.",
        }),
      ),
      HttpApiEndpoint.get("runs", TaskPaths.runs, {
        params: { taskID: Task.ID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(Task.Run), "Run history for the task, newest first"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task.runs",
          summary: "List task runs",
          description: "Get the recorded runs of a scheduled task, newest first.",
        }),
      ),
      HttpApiEndpoint.post("create", TaskPaths.list, {
        query: WorkspaceRoutingQuery,
        payload: Task.CreateInput,
        success: described(Task.Info, "Created task"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task.create",
          summary: "Create a scheduled task",
          description: "Create a scheduled task from a prompt and a cron expression or preset.",
        }),
      ),
      HttpApiEndpoint.get("get", TaskPaths.get, {
        params: { taskID: Task.ID },
        query: WorkspaceRoutingQuery,
        success: described(Task.Info, "Task information"),
        error: TaskNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task.get",
          summary: "Get a scheduled task",
          description: "Retrieve a single scheduled task by ID.",
        }),
      ),
      HttpApiEndpoint.patch("update", TaskPaths.get, {
        params: { taskID: Task.ID },
        query: WorkspaceRoutingQuery,
        payload: Task.UpdateInput,
        success: described(Task.Info, "Updated task information"),
        error: [HttpApiError.BadRequest, TaskNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task.update",
          summary: "Update a scheduled task",
          description: "Update a task's title, prompt, cron, enabled flag, session binding, or directory.",
        }),
      ),
      HttpApiEndpoint.delete("remove", TaskPaths.get, {
        params: { taskID: Task.ID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Task removed"),
        error: TaskNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task.remove",
          summary: "Delete a scheduled task",
          description: "Delete a scheduled task and its recorded runs.",
        }),
      ),
      HttpApiEndpoint.post("run", TaskPaths.run, {
        params: { taskID: Task.ID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Task fired"),
        error: TaskNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "task.run",
          summary: "Run a task now",
          description: "Fire a scheduled task immediately, outside its schedule.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "task",
        description: "Scheduled task routes.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
