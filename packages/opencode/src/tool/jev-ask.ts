import type { JSONSchema7 } from "@ai-sdk/provider"
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

/**
 * Decode-error text for a `criteria` payload past the vendor's per-question
 * serialized size bound. Measured on the JSON the wire actually carries (the
 * coerced choice record / the score level array), so the caller learns which
 * payload to shorten.
 */
export const CRITERIA_LENGTH_MESSAGE =
  "serialized `criteria` must be at most 2000 characters per question — shorten the option or level descriptions"

/**
 * Decode-error text for the score arm's `criteria` field: the vendor accepts an
 * ordered array of 2-10 levels, and the record form is a 422 (`list_type`), so
 * say both instead of letting the raw mismatch echo the bad payload back.
 */
export const SCORE_CRITERIA_MESSAGE =
  "score criteria is an ORDERED array of 2-10 level descriptions (lowest first) — a record is never accepted"

/**
 * Decode-error text for a TYPED `choice` question that omitted its required
 * `criteria` key. Raw struct decoding reads as `Missing key criteria`, which
 * teaches the caller nothing; state that criteria is required and what it takes.
 */
export const CHOICE_CRITERIA_REQUIRED_MESSAGE =
  'choice questions REQUIRE criteria — a record of label → description, e.g. { keep: "helps", drop: "irrelevant" }'

/**
 * Decode-error text for a TYPED `score` question that omitted its required
 * `criteria` key — the arm-specific fix for the raw `Missing key criteria`.
 */
export const SCORE_CRITERIA_REQUIRED_MESSAGE =
  "score questions REQUIRE criteria — an ORDERED array of 2-10 level descriptions (lowest first)"

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

const failScoreCriteria = (input: unknown) =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(input), { message: SCORE_CRITERIA_MESSAGE }))

// Vendor level bounds (2–10); never truncated — dropping a level would corrupt the scale.
const SCORE_LEVELS_MIN = 2
const SCORE_LEVELS_MAX = 10

/** Vendor bound on serialized criteria per question, measured on the JSON the wire carries. */
const CRITERIA_MAX = 2000

const serializedLength = (criteria: unknown) => JSON.stringify(criteria).length

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
        if (descriptions.length !== input.length) return failChoiceCriteria(input)
        if (descriptions.length < CHOICE_OPTIONS_MIN || descriptions.length > CHOICE_OPTIONS_MAX)
          return failChoiceCriteria(input)
        const coerced = Object.fromEntries(
          choiceLabels(descriptions).map((label, index) => [label, descriptions[index]] as const),
        )
        return serializedLength(coerced) > CRITERIA_MAX
          ? Effect.fail(new SchemaIssue.InvalidValue(Option.some(input), { message: CRITERIA_LENGTH_MESSAGE }))
          : Effect.succeed(coerced)
      }
      const entries = Object.entries(input)
      if (
        entries.length < CHOICE_OPTIONS_MIN ||
        entries.length > CHOICE_OPTIONS_MAX ||
        entries.some(([, description]) => typeof description !== "string")
      )
        return failChoiceCriteria(input)
      const record = Object.fromEntries(entries.map(([label, description]) => [label, String(description)] as const))
      return serializedLength(record) > CRITERIA_MAX
        ? Effect.fail(new SchemaIssue.InvalidValue(Option.some(input), { message: CRITERIA_LENGTH_MESSAGE }))
        : Effect.succeed(record)
    }),
    encode: SchemaGetter.passthrough(),
  }),
)

/**
 * Default `instructions` per arm. `instructions` is optional-with-default on
 * EVERY arm, so a missing descriptive field must NEVER reject the batch: each
 * arm decodes to a wire-valid payload carrying a default instruction. This
 * eliminates the whole `Missing key ["instructions"]` failure class — one
 * instance being a score question that omitted instructions — not just one arm.
 */
export const INSTRUCTIONS_DEFAULTS = {
  choice: "Pick the option that best satisfies the goal given the criteria",
  score: "Rate on the provided scale, lowest level = lowest score",
  noul: "1 = yes / affirmative, 0 = no",
} as const

/**
 * Per-type question shape, enforced HERE so the wire-422 class is impossible
 * from the tool boundary (jev.md §2): `choice` criteria is a record
 * `label → description`, `score` criteria is an ORDERED string array of level
 * descriptions (the record form is rejected with HTTP 422 `list_type`), and
 * `noul` carries no criteria at all (`Schema.Never`, so passing one fails
 * decode rather than the endpoint).
 */
const QuestionArms = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("choice"),
    instructions: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed(INSTRUCTIONS_DEFAULTS.choice))),
    // A bare string array is accepted here (callers conflate it with `score`)
    // and normalized into the record the wire requires.
    criteria: ChoiceCriteria.annotate({
      description: "label → description, e.g. { keep: \"helps\", drop: \"irrelevant\" }",
    }),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("score"),
    instructions: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed(INSTRUCTIONS_DEFAULTS.score))),
    // Unknown-encoded like the choice arm, so an out-of-range level count or an
    // oversized payload fails with guidance instead of a raw mismatch.
    criteria: Schema.Unknown.pipe(
      Schema.decodeTo(Schema.Array(Schema.String), {
        decode: SchemaGetter.transformOrFail((input) => {
          if (!Array.isArray(input)) return failScoreCriteria(input)
          const levels = input.filter((level): level is string => typeof level === "string")
          if (levels.length !== input.length) return failScoreCriteria(input)
          if (levels.length < SCORE_LEVELS_MIN || levels.length > SCORE_LEVELS_MAX) return failScoreCriteria(input)
          return serializedLength(levels) > CRITERIA_MAX
            ? Effect.fail(new SchemaIssue.InvalidValue(Option.some(input), { message: CRITERIA_LENGTH_MESSAGE }))
            : Effect.succeed(levels)
        }),
        encode: SchemaGetter.passthrough(),
      }),
    ).annotate({
      description: "Ordered level descriptions, LOWEST first (an array, never a record)",
    }),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("noul"),
    instructions: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed(INSTRUCTIONS_DEFAULTS.noul))),
    criteria: Schema.optional(Schema.Never).annotate({ message: NOUL_CRITERIA_MESSAGE }),
  }).annotate({
    description:
      'yes/no probability question — carries NO criteria; outcome semantics go in `instructions` (e.g. "1 = premise holds, 0 = it does not")',
  }),
]).annotate({ discriminator: "type" })

/**
 * Guided message for a typed question whose `criteria` KEY is absent. Handled
 * before the union so a missing required field reads as the fix, not the raw
 * `Missing key criteria`; an untyped question is exempt because it INFERS its
 * arm from the very field that is missing (no criteria → noul).
 */
const missingCriteriaMessage = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const question = input as Record<string, unknown>
  if ("criteria" in question) return undefined
  if (question["type"] === "choice") return CHOICE_CRITERIA_REQUIRED_MESSAGE
  if (question["type"] === "score") return SCORE_CRITERIA_REQUIRED_MESSAGE
  return undefined
}

/**
 * Missing-`type` inference, decode-side only. A question object without a
 * `type` key is unambiguous in shape: an array `criteria` is the score arm, a
 * record `criteria` the choice arm (whose own array→record coercion still
 * applies), and NO `criteria` key the noul arm (the instructions default then
 * applies). Objects that carry `type` pass through untouched — they decode
 * exactly as before — and non-objects keep today's failure. Same rule as
 * INSTRUCTIONS_DEFAULTS: normalize what the body already implies, reject only
 * the genuinely uninterpretable.
 */
const inferQuestionType = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const question = input as Record<string, unknown>
  if ("type" in question) return input
  if (!("criteria" in question)) return { ...question, type: "noul" }
  if (Array.isArray(question["criteria"])) return { ...question, type: "score" }
  if (typeof question["criteria"] === "object" && question["criteria"] !== null) return { ...question, type: "choice" }
  return input
}

/**
 * The model-facing question boundary: normalize the unambiguous (infer a missing
 * discriminator, guide a missing criteria key) then decode the unchanged union.
 * The decoded type is the union's, so `toQuestions` and the tool see no change.
 */
export const Question = Schema.Unknown.pipe(
  Schema.decodeTo(QuestionArms, {
    decode: SchemaGetter.transformOrFail((input) => {
      const required = missingCriteriaMessage(input)
      if (required !== undefined) return Effect.fail(new SchemaIssue.InvalidValue(Option.some(input), { message: required }))
      return Effect.succeed(inferQuestionType(input) as Schema.Codec.Encoded<typeof QuestionArms>)
    }),
    encode: SchemaGetter.passthrough(),
  }),
)

export const Parameters = Schema.Struct({
  goal: Schema.String.annotate({
    description: "What the decision is for — the decision state sent as `state`",
  }),
  questions: Schema.Array(Question).annotate({
    description: "Typed questions to ask in ONE request; answers come back keyed by the same ids",
  }),
})

// Hand-authored because `criteria` is deliberately Unknown-encoded above for
// tolerant, message-carrying decode failures; that makes the GENERATED JSON
// schema render `criteria` shapeless (`{}`), so the model never learns the
// per-arm wire shape. This is what the model sees; the test file pins it in
// sync with the decode behavior the same file enforces.
const choiceArm: JSONSchema7 = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { const: "choice" },
    instructions: { type: "string" },
    criteria: {
      type: "object",
      additionalProperties: { type: "string" },
      description: 'label → description, e.g. { keep: "helps", drop: "irrelevant" }',
    },
  },
  required: ["id", "type", "criteria"],
  additionalProperties: false,
}

const scoreArm: JSONSchema7 = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { const: "score" },
    instructions: { type: "string" },
    criteria: {
      type: "array",
      items: { type: "string" },
      minItems: SCORE_LEVELS_MIN,
      maxItems: SCORE_LEVELS_MAX,
      description: "Ordered level descriptions, LOWEST first (an array, never a record)",
    },
  },
  required: ["id", "type", "criteria"],
  additionalProperties: false,
}

const noulArm: JSONSchema7 = {
  type: "object",
  description:
    'yes/no probability question — carries NO criteria; outcome semantics go in `instructions` (e.g. "1 = premise holds, 0 = it does not")',
  properties: {
    id: { type: "string" },
    type: { const: "noul" },
    instructions: { type: "string" },
  },
  required: ["id", "type"],
  additionalProperties: false,
}

export const ParametersJsonSchema: JSONSchema7 = {
  type: "object",
  properties: {
    goal: {
      type: "string",
      description: "What the decision is for — the decision state sent as `state`",
    },
    questions: {
      type: "array",
      items: { anyOf: [choiceArm, scoreArm, noulArm] },
      description: "Typed questions to ask in ONE request; answers come back keyed by the same ids",
    },
  },
  required: ["goal", "questions"],
  additionalProperties: false,
}

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = {}

// Vendor bound: questions per request.
export const QUESTIONS_MAX = 8

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
      jsonSchema: ParametersJsonSchema,
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
