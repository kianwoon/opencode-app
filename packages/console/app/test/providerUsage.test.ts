import { describe, expect, test } from "bun:test"
import type { ZenData } from "@opencode-ai/console-core/model.js"
import type { ProviderHelper } from "../src/routes/zen/util/provider/provider"
import { buildFinishChunk, observeStreamFragment } from "../src/routes/zen/util/provider/provider"
import { anthropicHelper } from "../src/routes/zen/util/provider/anthropic"
import { googleHelper } from "../src/routes/zen/util/provider/google"
import {
  fromOaCompatibleChunk,
  oaCompatHelper,
  toOaCompatibleChunk,
} from "../src/routes/zen/util/provider/openai-compatible"
import { openaiHelper } from "../src/routes/zen/util/provider/openai"

const providers = {
  anthropic: anthropicHelper({ reqModel: "claude-haiku-4-5", providerModel: "claude-haiku-4-5" }),
  google: googleHelper({ reqModel: "gemini-3-flash", providerModel: "gemini-3-flash" }),
  openai: openaiHelper({ reqModel: "gpt-5", providerModel: "gpt-5" }),
  "oa-compat": oaCompatHelper({ reqModel: "gpt-5-nano", providerModel: "gpt-5-nano" }),
} satisfies Record<ZenData.Format, ReturnType<ProviderHelper>>

describe("provider usage extraction", () => {
  test("extracts Google non-stream usage metadata", () => {
    const usage = providers.google.extractUsage({
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 2,
        cachedContentTokenCount: 4,
      },
    })

    expect(providers.google.normalizeUsage(usage)).toEqual({
      inputTokens: 6,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 4,
      cacheWrite5mTokens: undefined,
      cacheWrite1hTokens: undefined,
    })
  })

  test("parses Google stream usage metadata", () => {
    const usageParser = providers.google.createUsageParser()
    usageParser.parse(
      'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":2,"cachedContentTokenCount":4}}',
    )

    expect(providers.google.normalizeUsage(usageParser.retrieve())).toEqual({
      inputTokens: 6,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 4,
      cacheWrite5mTokens: undefined,
      cacheWrite1hTokens: undefined,
    })
  })

  test("extracts nested OpenAI Responses usage", () => {
    expect(
      providers.openai.extractUsage({
        response: {
          usage: {
            input_tokens: 5,
            output_tokens: 7,
          },
        },
      }),
    ).toEqual({
      input_tokens: 5,
      output_tokens: 7,
    })
  })

  test("parses OpenAI stream cache write usage", () => {
    const usageParser = providers.openai.createUsageParser()
    usageParser.parse(
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":4,"cache_write_tokens":3},"output_tokens":2}}}',
    )

    expect(providers.openai.normalizeUsage(usageParser.retrieve())).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      reasoningTokens: undefined,
      cacheReadTokens: 4,
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: undefined,
    })
  })

  test("clamps input tokens when detail fields overlap", () => {
    const usageParser = providers.openai.createUsageParser()
    usageParser.parse(
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"input_tokens_details":{"cached_tokens":4,"cache_write_tokens":3},"output_tokens":2}}}',
    )

    expect(providers.openai.normalizeUsage(usageParser.retrieve())).toEqual({
      inputTokens: 0,
      outputTokens: 2,
      reasoningTokens: undefined,
      cacheReadTokens: 4,
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: undefined,
    })
  })
})

describe("oa-compat finish reason normalization", () => {
  const chunk = (choice: Record<string, unknown>) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, ...choice }],
    })}`

  const finishOf = (raw: string): string | null | undefined => {
    const parsed = fromOaCompatibleChunk(raw)
    if (typeof parsed === "string") throw new Error("expected a parsed chunk")
    return parsed.choices[0]?.finish_reason
  }

  test("synthesizes stop for a bare empty-delta terminator with no finish reason", () => {
    expect(finishOf(chunk({ delta: {}, finish_reason: null }))).toBe("stop")
  })

  test("synthesizes stop for non-standard upstream reasons", () => {
    expect(finishOf(chunk({ delta: {}, finish_reason: "end_turn" }))).toBe("stop")
  })

  test("passes standard reasons through unchanged", () => {
    expect(finishOf(chunk({ delta: {}, finish_reason: "stop" }))).toBe("stop")
    expect(finishOf(chunk({ delta: {}, finish_reason: "length" }))).toBe("length")
    expect(finishOf(chunk({ delta: {}, finish_reason: "content_filter" }))).toBe("content_filter")
    expect(finishOf(chunk({ delta: {}, finish_reason: "tool_calls" }))).toBe("tool_calls")
  })

  test("passes network_error through so retry mapping still fires", () => {
    expect(finishOf(chunk({ delta: {}, finish_reason: "network_error" }))).toBe("network_error")
  })

  test("does not synthesize a terminal reason on content-bearing deltas", () => {
    expect(finishOf(chunk({ delta: { content: "hello" }, finish_reason: null }))).toBe(null)
  })

  test("toOaCompatibleChunk emits stop for an empty terminal delta", () => {
    const out = toOaCompatibleChunk({
      id: "x",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    })
    expect(JSON.parse(out.slice(6)).choices[0].finish_reason).toBe("stop")
  })
})

describe("zen stream-close finish synthesis", () => {
  test("buildFinishChunk emits an oa-compat terminal stop chunk", () => {
    const out = buildFinishChunk("oa-compat")
    const payload = JSON.parse(out.slice(6))
    expect(payload.choices[0].finish_reason).toBe("stop")
  })

  test("buildFinishChunk emits an anthropic message_delta end_turn", () => {
    const out = buildFinishChunk("anthropic")
    expect(out).toContain("message_delta")
    expect(out).toContain('"stop_reason":"end_turn"')
  })

  test("observeStreamFragment tracks oa-compat output and terminal reasons", () => {
    const state = { sawOutput: false, sawTerminal: false }
    observeStreamFragment("oa-compat", 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}', state)
    expect(state.sawOutput).toBe(true)
    expect(state.sawTerminal).toBe(false)
    observeStreamFragment("oa-compat", 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}', state)
    expect(state.sawTerminal).toBe(true)
  })

  test("observeStreamFragment flags tool_call deltas as output", () => {
    const state = { sawOutput: false, sawTerminal: false }
    observeStreamFragment("oa-compat", 'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]},"finish_reason":null}]}', state)
    expect(state.sawOutput).toBe(true)
    expect(state.sawTerminal).toBe(false)
  })

  test("observeStreamFragment leaves a genuinely empty stream untouched", () => {
    const state = { sawOutput: false, sawTerminal: false }
    observeStreamFragment("oa-compat", 'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}', state)
    expect(state.sawOutput).toBe(false)
    expect(state.sawTerminal).toBe(false)
  })
})
