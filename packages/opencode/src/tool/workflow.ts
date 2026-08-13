import * as Tool from "./tool"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID } from "../session/schema"
import { Session } from "@/session/session"
import { Effect, Schema } from "effect"
import { SessionPrompt } from "@/session/prompt"

/**
 * `workflow` — declare and run a multi-step pipeline (DAG) of subagent tasks.
 *
 * The model calls this tool with a list of steps and their dependencies. Each
 * step runs as a subagent task (the same engine as the `task` tool). Steps
 * with satisfied dependencies run concurrently; a failed step marks its
 * dependents as skipped. The tool emits a `WorkflowPart` into the session so
 * the harness loop dispatches it.
 */

export interface WorkflowPromptOps {
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const StepParams = Schema.Struct({
  id: Schema.String.annotate({ description: "Unique id for this step within the workflow" }),
  prompt: Schema.String.annotate({ description: "What the step's subagent should do" }),
  description: Schema.String.annotate({ description: "Short description of the step" }),
  agent: Schema.String.annotate({ description: "Subagent type to run this step (e.g. build, general)" }),
  dependsOn: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Step ids that must complete before this one runs. Omit for no dependency.",
  }),
})

const Parameters = Schema.Struct({
  title: Schema.String.annotate({ description: "Name of the workflow" }),
  steps: Schema.Array(StepParams).annotate({
    description:
      "The pipeline steps. Each step runs as a subagent task; independent steps run in parallel.",
  }),
})

const DESCRIPTION_TEXT = [
  "Declare a multi-step workflow (DAG) where each step is a subagent task.",
  "Steps can depend on other steps via dependsOn. Steps with no unsatisfied",
  "dependencies run concurrently. If a step fails, its dependents are skipped.",
  "Use this for pipelines that need ordering or parallelism across distinct",
  "subagent tasks (build then test+lint then publish).",
].join(" ")

export const WorkflowTool = Tool.define(
  "workflow",
  Effect.gen(function* () {
    const session = yield* Session.Service
    return {
      description: DESCRIPTION_TEXT,
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const ops = ctx.extra?.promptOps as WorkflowPromptOps | undefined
          if (!ops) return yield* Effect.fail(new Error("WorkflowTool requires promptOps in ctx.extra"))

          const current = yield* session.get(ctx.sessionID)
          const steps = params.steps.map((step) => ({
            id: step.id,
            prompt: step.prompt,
            description: step.description,
            agent: step.agent,
            dependsOn: [...(step.dependsOn ?? [])],
          }))

          yield* ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: ctx.sessionID,
            agent: current.agent ?? ctx.agent,
            parts: [
              {
                type: "workflow",
                title: params.title,
                steps,
              } satisfies SessionV1.WorkflowPartInput,
            ],
          })

          return {
            title: `Workflow: ${params.title}`,
            metadata: { workflow: params.title, steps: steps.length },
            output: [
              `Workflow "${params.title}" started with ${steps.length} step(s).`,
              ...steps.map((s) => `- ${s.id}${s.dependsOn.length ? ` (after: ${s.dependsOn.join(", ")})` : ""}`),
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
