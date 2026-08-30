import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { define } from "@opencode-ai/plugin/v2/effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("messages.transform", () => {
  it.effect("runs registered transforms against the in-flight messages", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const messages = PluginHost.makeMessagesTransform()
      const host = yield* PluginHost.make(plugin, messages)

      const effectPlugin = define({
        id: "messages-example",
        effect: (ctx) =>
          ctx.messages.transform((msgs) => {
            for (const m of msgs) {
              if (m.type === "assistant") {
                m.content = m.content.filter((item) => item.type !== "reasoning")
              }
            }
          }),
      })
      yield* effectPlugin.effect(host)

      const draft = [
        {
          type: "assistant",
          id: "a1",
          agent: "build",
          model: { providerID: "deepseek", id: "flash" },
          time: { created: 0 },
          content: [
            { type: "reasoning", id: "r1", text: "thinking" },
            { type: "text", id: "t1", text: "answer" },
          ],
        },
      ] as any

      yield* messages.invoke(draft)
      expect(draft[0].content.map((c: { type: string }) => c.type)).toEqual(["text"])
    }),
  )

  it.effect("disposes the transform registration when the scope closes", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const messages = PluginHost.makeMessagesTransform()
      const host = yield* PluginHost.make(plugin, messages)

      const effectPlugin = define({
        id: "messages-dispose",
        effect: (ctx) =>
          ctx.messages.transform((msgs) => {
            for (const m of msgs) if (m.type === "assistant") m.content = []
          }),
      })
      yield* effectPlugin.effect(host)

      const draft = [
        {
          type: "assistant",
          id: "a1",
          agent: "build",
          model: {},
          time: { created: 0 },
          content: [{ type: "text", id: "t", text: "x" }],
        },
      ] as any
      yield* messages.invoke(draft)
      expect(draft[0].content.length).toBe(0)
    }),
  )
})
