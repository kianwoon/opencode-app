/**
 * Batch / map-reduce classifier (decision seam #10).
 *
 * Cheaply process large sets of INDEPENDENT states: split into chunks, ask ONE
 * batched question per item per chunk (never one request per item), then fold
 * the per-item outcomes into summary counts. Chunks are processed SEQUENTIALLY —
 * the safest bounded-concurrency choice, since each chunk is already one request
 * and parallel fan-out would multiply upstream load for no latency win. Fail-open
 * is PER CHUNK: a chunk whose request errors contributes `unknown` outcomes for
 * its items and never discards the results of other chunks.
 *
 * Nothing calls this yet; wiring it into the loop is a later piece.
 *
 * @module @opencode-ai/opencode/classifier/batch
 */
export * as ClassifierBatch from "./batch"

import { Effect } from "effect"

import { type Answer, type ReasonCode } from "./schema"
import { ClassifierClient } from "./client"

// --- Pure state --------------------------------------------------------------

/** Split `items` into consecutive chunks of at most `size` (size floored to 1). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const width = Math.max(1, Math.floor(size))
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += width) {
    chunks.push(items.slice(index, index + width))
  }
  return chunks
}

/**
 * One `noul` question per item, keyed by its GLOBAL index (`${offset}:${index}`)
 * so answers map back across chunks without collisions between chunk-local ids.
 */
export function buildBatchQuestions(
  chunkItems: readonly unknown[],
  instruction: string,
  offset = 0,
): Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> {
  return Object.fromEntries(
    chunkItems.map((item, index) => [
      `${offset + index}`,
      {
        type: "noul" as const,
        instructions: `${instruction} Item: ${typeof item === "string" ? item : JSON.stringify(item)}`,
        criteria: { true: "yes", false: "no" },
      },
    ]),
  )
}

export type BatchOutcome = "yes" | "no" | "unknown"

/** Per-item result: the global index plus the folded outcome. */
export interface BatchItemResult {
  readonly index: number
  readonly outcome: BatchOutcome
}

export interface BatchAggregate {
  readonly total: number
  readonly yes: number
  readonly no: number
  readonly unknown: number
}

/** Fold per-item outcomes into summary counts. Pure. */
export function aggregate(results: readonly BatchItemResult[], total: number): BatchAggregate {
  const yes = results.filter((result) => result.outcome === "yes").length
  const no = results.filter((result) => result.outcome === "no").length
  return { total, yes, no, unknown: Math.max(0, total - yes - no) }
}

/** Extract the outcome from a `noul` P(yes) at the 0.5 midpoint; absent → unknown. */
export function outcomeFromAnswer(answer: Answer | undefined): BatchOutcome {
  if (!answer || answer.type !== "noul") return "unknown"
  if (!Number.isFinite(answer.noul)) return "unknown"
  return answer.noul >= 0.5 ? "yes" : "no"
}

// --- Effectful half (one Jev batch per chunk, sequential) --------------------

export interface BatchResult {
  readonly results: BatchItemResult[]
  readonly aggregate: BatchAggregate
  readonly chunks: number
  readonly failedChunks: number
}

/**
 * Process items in chunks, ONE `client.ask` per chunk, sequentially. Fail-open
 * per chunk: an errored chunk marks ITS items `unknown` and the fold continues,
 * so a single bad chunk never loses the other chunks' results.
 */
export const classifyBatch = (input: {
  client: ClassifierClient.Interface
  model: string
  instruction: string
  items: readonly unknown[]
  chunkSize: number
  /** Projects an item to the `state` string sent for its chunk. */
  mapItem?: (item: unknown, index: number) => string
}): Effect.Effect<BatchResult, ClassifierClient.SystemOneError> =>
  Effect.gen(function* () {
    const chunks = chunk(input.items, input.chunkSize)
    const results: BatchItemResult[] = []
    let offset = 0
    let failedChunks = 0

    for (const current of chunks) {
      const mapped = current.map((item, index) => input.mapItem?.(item, offset + index) ?? JSON.stringify(item))
      const questions = buildBatchQuestions(current, input.instruction, offset)
      const answers = yield* input.client
        .ask({ model: input.model, state: mapped.join("\n"), questions })
        .pipe(
          Effect.map((response) => response.answers),
          // Fail-open per chunk: an error here only marks THIS chunk's items unknown.
          Effect.catch(() => {
            failedChunks += 1
            return Effect.succeed({} as Record<string, Answer>)
          }),
        )
      current.forEach((_item, index) => {
        results.push({ index: offset + index, outcome: outcomeFromAnswer(answers[String(offset + index)]) })
      })
      offset += current.length
    }

    return {
      results,
      aggregate: aggregate(results, input.items.length),
      chunks: chunks.length,
      failedChunks,
    }
  })
