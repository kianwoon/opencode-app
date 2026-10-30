import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { MCP } from "../mcp"
import * as Tool from "./tool"

const MAX_ACTIONS = 30
const DEFAULT_TIMEOUT = 30_000
const MAX_TEXT_CHARS = 200

// This Effect build's `Schema.Literal` accepts a single value, so a closed set
// of strings is a Union of single-value literals (JSON Schema still collapses
// it to an enum).
function enumeration<Values extends string[]>(...values: Values) {
  return Schema.Union(values.map((value) => Schema.Literal(value)))
}

// Field groups copied verbatim from the cua-driver (v0.28.2) actuator input
// schemas. Kept as shared records because the same field set recurs verbatim
// across most actuators; `Schema.Struct` spread keeps each action's shape
// identical to its `cua-driver_<use>` counterpart.
const targetFields = {
  pid: Schema.optional(Schema.Int),
  window_id: Schema.optional(Schema.Int),
  scope: Schema.optional(enumeration("window", "desktop")),
  session: Schema.optional(Schema.String),
  delivery_mode: Schema.optional(enumeration("background", "foreground")),
  target: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("window"), pid: Schema.Int, window_id: Schema.Int }),
      Schema.Struct({ kind: Schema.Literal("desktop"), display_id: Schema.String }),
    ]),
  ),
}

const pixelFields = {
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
}

const elementFields = {
  element_index: Schema.optional(Schema.Int),
  element_token: Schema.optional(Schema.String),
  snapshot_id: Schema.optional(Schema.String),
}

export const Action = Schema.Union([
  Schema.Struct({
    use: Schema.Literal("click"),
    ...targetFields,
    ...pixelFields,
    ...elementFields,
    action: Schema.optional(
      enumeration("press", "show_menu", "pick", "confirm", "cancel", "open"),
    ),
    button: Schema.optional(enumeration("left", "right", "middle")),
    count: Schema.optional(Schema.Int),
    from_zoom: Schema.optional(Schema.Boolean),
    debug_image_out: Schema.optional(Schema.String),
    modifier: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    use: Schema.Literal("bring_to_front"),
    pid: Schema.optional(Schema.Int),
    window_id: Schema.optional(Schema.Int),
  }),
  Schema.Struct({
    use: Schema.Literal("hotkey"),
    ...targetFields,
    ...pixelFields,
    ...elementFields,
    keys: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    use: Schema.Literal("press_key"),
    ...targetFields,
    ...pixelFields,
    ...elementFields,
    key: Schema.String,
    modifiers: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    use: Schema.Literal("clipboard_write"),
    session: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    image_path: Schema.optional(Schema.String),
    file_path: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    use: Schema.Literal("type_text"),
    ...targetFields,
    ...pixelFields,
    ...elementFields,
    text: Schema.String,
    delay_ms: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
  }),
  Schema.Struct({
    use: Schema.Literal("scroll"),
    ...targetFields,
    ...pixelFields,
    ...elementFields,
    direction: Schema.optional(enumeration("up", "down", "left", "right")),
    by: Schema.optional(enumeration("line", "page")),
    amount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  Schema.Struct({
    use: Schema.Literal("drag"),
    ...targetFields,
    from_x: Schema.Number,
    from_y: Schema.Number,
    to_x: Schema.Number,
    to_y: Schema.Number,
    duration_ms: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 }))),
    steps: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
    button: Schema.optional(enumeration("left", "right", "middle")),
    from_zoom: Schema.optional(Schema.Boolean),
    modifier: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    use: Schema.Literal("set_value"),
    ...elementFields,
    pid: Schema.optional(Schema.Int),
    window_id: Schema.optional(Schema.Int),
    session: Schema.optional(Schema.String),
    value: Schema.String,
  }),
  Schema.Struct({ use: Schema.Literal("wait"), ms: Schema.Number }),
]).annotate({ identifier: "CuaBatchAction", discriminator: "use" })
export type Action = Schema.Schema.Type<typeof Action>

export const Parameters = Schema.Struct({
  actions: Schema.Array(Action).annotate({
    description:
      "Ordered action script. Each action's fields must match the input schema of the corresponding cua-driver_<use> tool; `wait` sleeps for ms between actions.",
  }),
  stop_on_error: Schema.optional(Schema.Boolean).annotate({
    description: "Stop at the first failing action and skip the rest. Defaults to true.",
  }),
})

type Metadata = {}

type ContentItem = { type: string; text?: string }

function textOf(content: readonly ContentItem[]): string {
  return content
    .flatMap((item) => (item.type === "text" && item.text ? [item.text] : []))
    .filter((text) => text.trim())
    .join("\n\n")
}

// Image and audio blocks would serialize as base64 into a model-visible tool
// output, so only the block type is reported for them.
function summaryOf(content: readonly ContentItem[]): string {
  const parts = content.flatMap((item) =>
    item.type === "text" && item.text
      ? [item.text.trim().slice(0, MAX_TEXT_CHARS)]
      : item.type === "image" || item.type === "audio"
        ? [`[${item.type} omitted]`]
        : [],
  )
  return parts.length ? ` — ${parts.join(" | ")}` : ""
}

export const CuaBatchTool = Tool.define<typeof Parameters, Metadata, MCP.Service>(
  "cua_batch",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    return {
      description:
        "Run a typed script of cua-driver actuator actions in ONE call: one decision, many GUI actions, no model turn between them. Supported `use` values: click, bring_to_front, hotkey, press_key, clipboard_write, type_text, scroll, drag, set_value, plus a local `wait` that sleeps `ms` between actions. Each action's remaining fields must match the input schema of the matching `cua-driver_<use>` tool. Actions run in order and each reports [ok]/[fail]; stop_on_error (default true) skips the remainder after a failure. Actuator effects are usually unverifiable by the driver — observe before and after with cua-driver_get_desktop_state or cua-driver_get_window_state. Requires the cua-driver MCP server; returns a not-connected notice otherwise.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const tools = yield* mcp.tools()
          if (!Object.keys(tools).some((key) => key.startsWith("cua-driver_"))) {
            return {
              title: "cua_batch (unavailable)",
              metadata: {},
              output: "cua-driver MCP server is not connected",
            }
          }
          if (params.actions.length > MAX_ACTIONS) {
            return {
              title: "cua_batch (rejected)",
              metadata: {},
              output: `cua_batch accepts at most ${MAX_ACTIONS} actions per call; received ${params.actions.length}. Split the script across calls.`,
            }
          }

          const lines: string[] = []
          for (const action of params.actions) {
            if (params.stop_on_error !== false && lines.some((line) => line.startsWith("[fail]"))) {
              lines.push(`[skip] ${action.use}`)
              continue
            }
            if (action.use === "wait") {
              yield* Effect.sleep(`${action.ms} millis`)
              lines.push(`[ok] wait (${action.ms}ms)`)
              continue
            }
            const tool = tools[`cua-driver_${action.use}`]
            if (!tool) {
              lines.push(`[fail] ${action.use}: tool not found on cua-driver server`)
              continue
            }
            const { use, ...args } = action
            const outcome = yield* Effect.exit(
              Effect.tryPromise(() =>
                tool.client.callTool(
                  { name: tool.def.name, arguments: args },
                  CallToolResultSchema,
                  {
                    resetTimeoutOnProgress: true,
                    signal: ctx.abort,
                    timeout: tool.timeout ?? DEFAULT_TIMEOUT,
                    onprogress: () => {},
                  },
                ),
              ),
            )
            if (Exit.isFailure(outcome)) {
              const message = Cause.prettyErrors(outcome.cause)
                .map(String)
                .join("\n\n")
              lines.push(`[fail] ${use}: ${message}`)
              continue
            }
            lines.push(
              outcome.value.isError
                ? `[fail] ${use}: ${textOf(outcome.value.content) || "MCP tool returned an error"}`
                : `[ok] ${use}${summaryOf(outcome.value.content)}`,
            )
          }

          const skipped = lines.filter((line) => line.startsWith("[skip]")).length
          return {
            title: `cua_batch (${lines.length - skipped}/${params.actions.length} executed)`,
            metadata: {},
            output: lines.join("\n"),
          }
        }),
    }
  }),
)
