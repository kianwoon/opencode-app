import { expect, test } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import { LLM, LLMEvent, Message, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { EventV2 } from "@opencode-ai/core/event"
import { Model } from "@opencode-ai/llm"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

namespace triggerHarness {
  const model = Model.make({
    id: "budget-model",
    provider: "fake",
    route: OpenAIChat.route.with({ limits: { context: 10_000, output: 100 } }),
  })

  export const makeCompaction = async (compaction: Partial<{ auto: boolean; trigger: number; buffer: number }> = {}) => {
    const documents: Config.Document[] = [
      new Config.Document({
        type: "document",
        info: new Config.Info({ compaction: new ConfigCompaction.Info(compaction) }),
      }),
    ]
    let summaryRequests: LLMRequest[] = []
    const compactionService = SessionCompaction.make({
      events: {
        publish: (definition: never, data: never) =>
          Effect.succeed({ id: "evt", type: definition, data, durable: undefined }) as never,
      } as unknown as EventV2.Interface,
      llm: {
        stream: (request: LLMRequest) => {
          summaryRequests.push(request)
          return Stream.make(
            LLMEvent.textDelta({ id: "sum", text: "Compact summary" }),
            LLMEvent.finish({ reason: "stop" }),
          )
        },
      },
      config: documents,
    })
    return { compaction: compactionService, model }
  }

  export const request = (messages: number): { entries: { seq: number; message: SessionMessage.Message }[]; request: LLMRequest } => {
    const created = DateTime.makeUnsafe(0)
    // History that overflows the default keep budget so a summary head exists.
    const entries = Array.from({ length: 100 }, (_, index) => ({
      seq: index,
      message: SessionMessage.User.make({
        id: SessionMessage.ID.make(`msg_seed${index}`),
        type: "user" as const,
        text: `entry ${index} ${"x".repeat(400)}`,
        time: { created },
      }),
    }))
    return {
      entries,
      request: LLM.request({
        model: Model.make({ id: "budget-model", provider: "fake", route: OpenAIChat.route }),
        messages: Array.from({ length: messages }, (_, index) => Message.user(`filler ${index} `.repeat(50))),
        tools: [],
      }),
    }
  }
}

test("compaction waits for the hard limit when no trigger fraction is configured", async () => {
  // Buffer kept small so the 10k test window is not dominated by the 20k default.
  const harness = await triggerHarness.makeCompaction({ buffer: 200 })
  // Hard limit ≈ 9.8k tokens; measured ≈ 151 tokens per filler message.
  const below = triggerHarness.request(55) // ≈ 8.3k tokens estimated
  expect(await Effect.runPromise(harness.compaction.compactIfNeeded({ ...below, sessionID: "ses_x" as never, model: harness.model }))).toBe(false)
  const above = triggerHarness.request(80) // ≈ 11.2k tokens estimated
  expect(await Effect.runPromise(harness.compaction.compactIfNeeded({ ...above, sessionID: "ses_x" as never, model: harness.model }))).toBe(true)
})

test("configured trigger fraction compacts proactively before the hard limit", async () => {
  const harness = await triggerHarness.makeCompaction({ trigger: 0.5, buffer: 200 })
  // 10k context * 0.5 = 5k token budget.
  const below = triggerHarness.request(25) // ≈ 3.8k tokens
  expect(await Effect.runPromise(harness.compaction.compactIfNeeded({ ...below, sessionID: "ses_x" as never, model: harness.model }))).toBe(false)
  const above = triggerHarness.request(40) // ≈ 6k tokens
  expect(await Effect.runPromise(harness.compaction.compactIfNeeded({ ...above, sessionID: "ses_x" as never, model: harness.model }))).toBe(true)
})

test("trigger rejects out-of-range fractions at config validation", () => {
  expect(
    () => new ConfigCompaction.Info({ trigger: 5 }),
  ).toThrow()
  expect(
    () => new ConfigCompaction.Info({ trigger: 0.01 }),
  ).toThrow()
})
