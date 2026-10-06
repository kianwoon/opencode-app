import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
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
 * Decode-error text for the choice arm's `criteria` field. The sibling `score`
 * arm legitimately takes an array, so a bare array for `choice` reads as a
 * near-miss; the raw mismatch (`Expected object, got [...]`) echoes the bad
 * array back and pushes the caller at the wrong shape, so state the fix.
 */
export const CHOICE_CRITERIA_MESSAGE =
  'choice criteria is a RECORD (label → description, e.g. { keep: "helps", drop: "irrelevant" }) — only `score` takes an array'

/** Vendor bound on a choice option label (question name ≤ 64 chars). */
const CHOICE_LABEL_MAX = 64

// Vendor option bounds (2–20). Enforced here rather than left to a wire 422,
// and never by truncation: silently dropping options would corrupt the decision.
const CHOICE_OPTIONS_MIN = 2
const CHOICE_OPTIONS_MAX = 20

const choiceLabel = (description: string) =>
  description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter((word) => word.length > 0)
    .slice(0, 3)
    .join("-")
    .slice(0, CHOICE_LABEL_MAX)
    .replace(/-+$/g, "")

const uniqueChoiceLabel = (base: string, taken: Set<string>, suffix: number): string => {
  const candidate = suffix === 1 ? base : `${base.slice(0, CHOICE_LABEL_MAX - String(suffix).length - 1)}-${suffix}`
  return taken.has(candidate) ? uniqueChoiceLabel(base, taken, suffix + 1) : candidate
}

const choiceLabels = (descriptions: string[]) => {
  const taken = new Set<string>()
  return descriptions.map((description) => {
    const label = uniqueChoiceLabel(choiceLabel(description) || "option", taken, 1)
    taken.add(label)
    return label
  })
}

const failChoiceCriteria = (input: unknown) =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(input), { message: CHOICE_CRITERIA_MESSAGE }))

/**
 * The encoded side is deliberately `Schema.Unknown` so EVERY malformed payload
 * — a bare scalar, an out-of-range option count, a non-string description —
 * reaches the transform and fails with CHOICE_CRITERIA_MESSAGE; this Effect
 * version drops a union `message` annotation for input rejected inside the
 * `from` AST. The tolerance is input-side only: the decoded type is still
 * `Record<string, string>`.
 */
const ChoiceCriteria = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Record(Schema.String, Schema.String), {
    decode: SchemaGetter.transformOrFail((input) => {
      if (typeof input !== "object" || input === null) return failChoiceCriteria(input)
      if (Array.isArray(input)) {
        const descriptions = input.filter((description): description is string => typeof description === "string")
        return descriptions.length === input.length &&
          descriptions.length >= CHOICE_OPTIONS_MIN &&
          descriptions.length <= CHOICE_OPTIONS_MAX
          ? Effect.succeed(
              Object.fromEntries(
                choiceLabels(descriptions).map((label, index) => [label, descriptions[index]] as const),
              ),
            )
          : failChoiceCriteria(input)
      }
      const entries = Object.entries(input)
      return entries.length < CHOICE_OPTIONS_MIN ||
        entries.length > CHOICE_OPTIONS_MAX ||
        entries.some(([, description]) => typeof description !== "string")
        ? failChoiceCriteria(input)
        : Effect.succeed(Object.fromEntries(entries.map(([label, description]) => [label, String(description)] as const)))
    }),
    encode: SchemaGetter.passthrough(),
  }),
)

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
    // A bare string array is accepted here (callers conflate it with `score`)
    // and normalized into the record the wire requires.
    criteria: ChoiceCriteria.annotate({
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
