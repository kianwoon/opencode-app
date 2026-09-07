import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../src"
import { Auth, LLMClient } from "../src/route"
import * as OpenRouter from "../src/providers/openrouter"
import { it } from "./lib/effect"

const openrouterModel = OpenRouter.route
  .with({ endpoint: { baseURL: "https://openrouter.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "deepseek/deepseek-chat" })

describe("openrouter provider pin on wire body", () => {
  it.effect("forwards whitelisted provider object + prompt_cache_key", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openrouterModel,
          prompt: "hi",
          providerOptions: {
            openrouter: { promptCacheKey: "abc", provider: { sort: "price", only: ["meta"] } },
          },
        }),
      )
      expect(prepared.body).toMatchObject({
        provider: { sort: "price", only: ["meta"] },
        prompt_cache_key: "abc",
      })
    }),
  )

  it.effect("drops invalid sort and slug with /", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openrouterModel,
          prompt: "hi",
          providerOptions: {
            openrouter: { provider: { sort: "fastest", only: ["meta/model"], order: ["streamlake"] } },
          },
        }),
      )
      expect(prepared.body).toMatchObject({ provider: { order: ["streamlake"] } })
      expect((prepared.body as Record<string, unknown>).provider).not.toHaveProperty("sort")
      expect((prepared.body as Record<string, unknown>).provider).not.toHaveProperty("only")
    }),
  )
})
