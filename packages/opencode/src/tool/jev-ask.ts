import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { jevKey } from "../jev/controller"
import { JEV_DEFAULT_TIMEOUT_MS, jevAsk, jevModelFor, parseJevAnswer, type JevTransport } from "../jev/client"

/**
 * Decode-error text for the noul arm's `criteria` field. Effect honors a
 * `message` annotation on the optional(Never) node even inside a
 * discriminated union, so the caller learns the fix instead of reading
 * `Expected never | undefined`.
 */
export const NOUL_CRITERIA_MESSAGE =
  'noul questions take NO criteria — encode the outcome semantics in `instructions` (e.g. "1 = premise holds, 0 = it does not")'

/**
 * Per-type question shape, enforced HERE so the wire-422 class is impossible
 * from the tool boundary (jev.md §2): `choice` criteria is a record
 * `label → description`, `score` criteria is an ORDERED string array of level
 * descriptions (the record form is rejected with HTTP 422 `list_type`), and
 * `noul` carries no criteria at all (`Schema.Never`, so passing one fails
 * decode rather than the endpoint).
 */
export const Question = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("choice"),
    instructions: Schema.String,
    criteria: Schema.Record(Schema.String, Schema.String).annotate({
      description: "label → description, e.g. { keep: \"helps\", drop: \"irrelevant\" }",
    }),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("score"),
    instructions: Schema.String,
    criteria: Schema.Array(Schema.String).annotate({
      description: "Ordered level descriptions, LOWEST first (an array, never a record)",
    }),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("noul"),
    instructions: Schema.String,
    criteria: Schema.optional(Schema.Never).annotate({ message: NOUL_CRITERIA_MESSAGE }),
  }).annotate({
    description:
      'yes/no probability question — carries NO criteria; outcome semantics go in `instructions` (e.g. "1 = premise holds, 0 = it does not")',
  }),
]).annotate({ discriminator: "type" })

export const Parameters = Schema.Struct({
  goal: Schema.String.annotate({
    description: "What the decision is for — the decision state sent as `state`",
  }),
  questions: Schema.Array(Question).annotate({
    description: "Typed questions to ask in ONE request; answers come back keyed by the same ids",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = {}

export const QUESTIONS_MAX = 32

/**
 * Marker for a question list that hit the QUESTIONS_MAX cap at this tool
 * boundary. Only the first QUESTIONS_MAX questions reach the endpoint, so the
 * hidden ids must be stated outright — never left to look like unmeasured
 * verdicts (mirrors `jev-decide`'s `truncationMarker`).
 */
export function truncationMarker(params: Params): string | undefined {
  if (params.questions.length <= QUESTIONS_MAX) return undefined
  const dropped = params.questions.slice(QUESTIONS_MAX).map((question) => question.id)
  return `questions truncated from ${params.questions.length} to ${QUESTIONS_MAX}; dropped ids: ${dropped.join(", ")}`
}

export function toQuestions(params: Params): Record<string, unknown> {
  return Object.fromEntries(
    params.questions.slice(0, QUESTIONS_MAX).map((question) => [
      question.id,
      {
        type: question.type,
        instructions: question.instructions,
        // noul has no criteria field at all (Schema.Never), so the spread is a
        // narrowing the schema already guarantees.
        ...("criteria" in question ? { criteria: question.criteria } : {}),
      },
    ]),
  )
}

export function toAskInput(params: Params, key: string, transport?: Pick<JevTransport, "endpoint" | "id">) {
  return {
    key,
    state: params.goal,
    questions: toQuestions(params),
    timeoutMs: JEV_DEFAULT_TIMEOUT_MS,
    model: jevModelFor(),
    ...(transport !== undefined ? { transport } : {}),
  }
}

/** One compact `id: primary-field` line per question, in question order. */
function summarize(params: Params, answers: Record<string, unknown>): string[] {
  return params.questions.slice(0, QUESTIONS_MAX).map((question) => {
    const parsed = parseJevAnswer(answers[question.id])
    if (parsed.type === "choice") return `${question.id}: choice=${parsed.choice}`
    if (parsed.type === "score") return `${question.id}: score=${parsed.score}`
    if (parsed.type === "noul") return `${question.id}: noul=${parsed.noul}`
    return `${question.id}: unmeasured`
  })
}

export function formatAsk(params: Params, answers: Record<string, unknown>): { title: string; output: string } {
  const marker = truncationMarker(params)
  return {
    title: "jev: ask",
    output: `${marker ? marker + "\n" : ""}${summarize(params, answers).join("\n")}\n${JSON.stringify(answers)}`,
  }
}

export function formatUnavailable(): { title: string; output: string } {
  return {
    title: "jev: unavailable",
    output: JSON.stringify({ decision: null, reason: "unavailable" }),
  }
}

/**
 * The whole tool body as one seam-testable function: an absent key short-circuits
 * BEFORE any request is built, and any fail-open path from `jevAsk` (transport
 * error, unknown provider, envelope without the `model` marker) returns
 * `undefined` for the caller to fold as unavailable.
 */
export async function askQuestions(
  params: Params,
  key: string | undefined,
  transport?: Pick<JevTransport, "endpoint" | "id">,
): Promise<{ title: string; output: string } | undefined> {
  if (!key) return undefined
  const answers = await jevAsk(toAskInput(params, key, transport))
  if (!answers) return undefined
  return formatAsk(params, answers)
}

export const JevAskTool = Tool.define<typeof Parameters, Metadata, never>(
  "jev_ask",
  Effect.gen(function* () {
    return {
      description:
        "Typed batch decision tool: send choice/score/noul questions in ONE SystemOne POST and get typed answers back; advisory, fail-open. Criteria are per-type: choice = record of label → description, score = ordered array of level descriptions, noul = none (outcome semantics go in `instructions`).",
      parameters: Parameters,
      execute: (params: Params) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => askQuestions(params, jevKey())).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!result) return { ...formatUnavailable(), metadata: {} }
          return { ...result, metadata: {} }
        }),
    }
  }),
)
