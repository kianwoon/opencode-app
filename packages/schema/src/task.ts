export * as Task from "./task"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { optional } from "./schema"
import { ascending } from "./identifier"
import { NonNegativeInt, statics } from "./schema"
import { SessionID } from "./session-id"
import { AbsolutePath } from "./schema"

export const ID = Schema.String.pipe(
  Schema.brand("Task.ID"),
  statics((schema) => ({ create: () => schema.make("task_" + ascending()) })),
)
export type ID = typeof ID.Type

export const RunID = Schema.String.pipe(
  Schema.brand("Task.RunID"),
  statics((schema) => ({ create: () => schema.make("tasr_" + ascending()) })),
)
export type RunID = typeof RunID.Type

export const Status = Schema.Literals(["active", "paused"])
export type Status = typeof Status.Type

export const RunStatus = Schema.Literals(["running", "completed", "failed", "skipped"])
export type RunStatus = typeof RunStatus.Type

export const Prompt = Schema.Struct({
  text: Schema.String.annotate({ description: "Prompt text submitted to the session on each fire" }),
}).annotate({ identifier: "Task.Prompt" })
export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}

export const Info = Schema.Struct({
  id: ID,
  title: Schema.String.annotate({ description: "Human-readable task name" }),
  prompt: Prompt,
  cron: Schema.String.annotate({
    description:
      "Cron expression (5-field) or one of the named presets: yearly, monthly, weekly, daily, hourly, minutely",
  }),
  enabled: Schema.Boolean.annotate({ description: "Whether the scheduler should fire this task" }),
  sessionID: SessionID.pipe(optional).annotate({
    description: "Session that receives each fire's prompt; created on first fire when absent",
  }),
  directory: AbsolutePath.annotate({
    description: "Working directory the bound session runs in",
  }),
  next_run_at: NonNegativeInt.pipe(optional).annotate({
    description: "Epoch millis of the next scheduled fire; absent while paused or invalid",
  }),
  last_run_at: NonNegativeInt.pipe(optional).annotate({ description: "Epoch millis of the most recent fire" }),
  missed_runs: NonNegativeInt.annotate({
    description: "Fires skipped because no process was awake at the scheduled time",
  }),
  run_count: NonNegativeInt.annotate({ description: "Total fires recorded, including skipped runs" }),
  time_created: NonNegativeInt,
  time_updated: NonNegativeInt,
}).annotate({ identifier: "Task" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Run = Schema.Struct({
  id: RunID,
  taskID: ID,
  sessionID: SessionID,
  status: RunStatus,
  started_at: NonNegativeInt,
  ended_at: NonNegativeInt.pipe(optional),
  error: Schema.String.pipe(optional),
}).annotate({ identifier: "Task.Run" })
export interface Run extends Schema.Schema.Type<typeof Run> {}

export const CreateInput = Schema.Struct({
  title: Schema.String,
  prompt: Prompt,
  cron: Schema.String,
  directory: AbsolutePath,
  enabled: optional(Schema.Boolean),
  sessionID: optional(SessionID),
}).annotate({ identifier: "Task.CreateInput" })
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const UpdateInput = Schema.Struct({
  title: optional(Schema.String),
  prompt: optional(Prompt),
  cron: optional(Schema.String),
  enabled: optional(Schema.Boolean),
  directory: optional(AbsolutePath),
}).annotate({ identifier: "Task.UpdateInput" })
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}

const Updated = define({
  type: "task.updated",
  durable: { version: 1, aggregate: "taskID" },
  schema: {
    task: Info,
  },
})
const Removed = define({
  type: "task.removed",
  durable: { version: 1, aggregate: "taskID" },
  schema: {
    taskID: ID,
  },
})

export const Event = { Updated, Removed, Definitions: inventory(Updated, Removed) }
