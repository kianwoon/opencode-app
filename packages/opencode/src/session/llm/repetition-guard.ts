import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent } from "@opencode-ai/llm"
import { MessageError } from "@/session/message-error"

type RepetitionLoopError = InstanceType<typeof MessageError.RepetitionLoopError>

/**
 * Degenerate repetition loop guard.
 *
 * Some models (notably behind aggregator/proxy providers) can enter a state
 * where they emit the same sentence or phrase forever without ever finishing a
 * tool call or the turn — e.g. "Let me commit. Let me commit. Let me commit. ...".
 * The provider keeps streaming because it never sees a stop token; opencode
 * keeps accepting deltas; the session hangs until the user aborts manually.
 *
 * This guard watches the assistant text stream for consecutive repetition of a
 * sentence, and aborts the stream with a non-retryable `RepetitionLoopError`
 * when the model has clearly degenerated.
 */

export type RepetitionGuardOptions = {
  /**
   * Minimum number of consecutive repeats of the same sentence to trigger.
   * @default 3
   */
  minRepeats?: number
  /**
   * Minimum sentence length (trimmed, chars) for a repeat to count. Very short
   * fragments ("ok.", "yes") legitimately repeat and are not degenerate.
   * @default 12
   */
  minSentenceLength?: number
  /**
   * Maximum amount of text the guard buffers for the sliding window (chars).
   * Prevents unbounded growth on long streams.
   * @default 16_000
   */
  maxWindowChars?: number
}

const DEFAULT_OPTIONS: Required<RepetitionGuardOptions> = {
  minRepeats: 3,
  minSentenceLength: 12,
  maxWindowChars: 16_000,
}

// Backward scan bound: degenerate repeats are adjacent, so anything older than
// a few sentences cannot contribute. Without this the per-delta scan is O(window)
// and a fast stream re-walks thousands of sentences per delta.
const maxScanSentences = 64

export class Guard {
  private sentences: string[] = []
  private pending = ""
  private chars = 0
  private triggered: string | undefined
  private options: Required<RepetitionGuardOptions>

  constructor(options: RepetitionGuardOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /** Feed accumulated assistant text; returns the repeated sentence if degenerate. */
  update(chunk: string): string | undefined {
    // Sticky once hot: the stream is aborted on first trigger, so a lagging
    // consumer must never see the loop as healthy again.
    if (this.triggered !== undefined) return this.triggered

    this.pending += chunk
    let start = 0
    for (let i = 0; i < this.pending.length; i++) {
      const char = this.pending[i]
      if (char === "." || char === "!" || char === "?" || char === "\n") {
        const token = this.pending.slice(start, i + 1).trim()
        if (token.length > 0) {
          this.sentences.push(token)
          this.chars += token.length
        }
        start = i + 1
      }
    }
    this.pending = this.pending.slice(start)
    while (this.chars > this.options.maxWindowChars && this.sentences.length > 0) {
      this.chars -= this.sentences[0]!.length
      this.sentences.shift()
    }

    this.triggered = scanRepetition(this.sentences, this.options)
    return this.triggered
  }
}

/**
 * Detects a degenerate repetition loop in accumulated assistant text.
 *
 * Exported separately so it can be unit-tested without the stream machinery.
 */
export function detectRepetition(text: string, options: RepetitionGuardOptions = {}): string | undefined {
  return scanRepetition(tokenize(text), options)
}

/**
 * Detects a degenerate repetition loop in pre-tokenized sentences, scanning
 * backward from the most recent sentence within a bounded window.
 */
function scanRepetition(sentences: string[], options: RepetitionGuardOptions): string | undefined {
  const { minRepeats, minSentenceLength } = { ...DEFAULT_OPTIONS, ...options }
  if (sentences.length < minRepeats) return undefined

  let repeatCount = 1
  const floor = Math.max(1, sentences.length - maxScanSentences)
  for (let i = sentences.length - 1; i >= floor; i--) {
    const sentence = sentences[i]
    const prev = sentences[i - 1]
    if (sentence === undefined || prev === undefined) break
    if (sentence === prev) {
      repeatCount++
      if (repeatCount >= minRepeats) {
        if (sentence.trim().length >= minSentenceLength) return sentence
        // Short repeated fragment is not degenerate by itself; keep scanning
        // the preceding window for a longer repeated sentence.
        repeatCount = 1
        continue
      }
    } else {
      repeatCount = 1
    }
  }
  return undefined
}

/**
 * Splits text into normalized sentence tokens.
 *
 * A token is a trimmed sentence ending in `.`, `!`, `?`, or a line break.
 * Trailing fragments that don't end in a boundary are dropped — they may be
 * mid-sentence and will complete on the next delta. This also means a repeated
 * sentence is only detected once at least one full copy has terminated.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    current += char
    if (char === "." || char === "!" || char === "?" || char === "\n") {
      const token = current.trim()
      if (token.length > 0) tokens.push(token)
      current = ""
    }
  }
  return tokens
}

/**
 * Applies the guard to an `LLMEvent` stream. Fails the stream with a
 * non-retryable `RepetitionLoopError` when the assistant text repeats.
 */
export function guardStream<E>(
  stream: Stream.Stream<LLMEvent, E>,
  options: RepetitionGuardOptions = {},
): Stream.Stream<LLMEvent, E | RepetitionLoopError> {
  const guard = new Guard(options)
  return Stream.mapEffect(stream, (event): Effect.Effect<LLMEvent, E | RepetitionLoopError> => {
    if (!LLMEvent.is.textDelta(event)) return succeed(event)
    const repeated = guard.update(event.text)
    if (repeated !== undefined) {
      return Effect.fail(
        new MessageError.RepetitionLoopError({
          repeated,
          message: `Assistant response degenerated into a repetition loop. Repeated: "${repeated}". This may be caused by the model/provider lacking frequency or presence penalty settings.`,
        }),
      )
    }
    return succeed(event)
  })
}

function succeed<E>(event: LLMEvent): Effect.Effect<LLMEvent, E | RepetitionLoopError> {
  return Effect.succeed(event) as Effect.Effect<LLMEvent, E | RepetitionLoopError>
}

export * as RepetitionGuard from "./repetition-guard"
