import { Effect, Schema } from "effect"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { ProviderID, type ModelID, type ProviderOptions } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAIChat from "../protocols/openai-chat"
import { isRecord } from "../protocols/shared"

export const profile = OpenAICompatibleProfiles.profiles.openrouter
export const id = ProviderID.make(profile.provider)
const ADAPTER = "openrouter"

export interface OpenRouterOptions {
  readonly [key: string]: unknown
  readonly usage?: boolean | Record<string, unknown>
  readonly reasoning?: Record<string, unknown>
  readonly promptCacheKey?: string
}

export type OpenRouterProviderOptionsInput = ProviderOptions & {
  readonly openrouter?: OpenRouterOptions
}

export type ModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenRouterProviderOptionsInput
  }

const OpenRouterBody = Schema.StructWithRest(Schema.Struct(OpenAIChat.bodyFields), [
  Schema.Record(Schema.String, Schema.Any),
])
export type OpenRouterBody = Schema.Schema.Type<typeof OpenRouterBody>

export const protocol = Protocol.make({
  id: "openrouter-chat",
  body: {
    schema: OpenRouterBody,
    from: (request) =>
      OpenAIChat.protocol.body.from(request).pipe(
        Effect.map(
          (body) =>
            ({
              ...body,
              ...bodyOptions(request.providerOptions?.openrouter),
            }) as OpenRouterBody,
        ),
      ),
  },
  stream: OpenAIChat.protocol.stream,
})

// Whitelisted OpenRouter `provider` routing object (mirrors
// packages/core/src/session/runner/llm.ts openrouterRouting — keep in sync).
// Invalid values are dropped; slugs must be bare (no "/" — those are model IDs).
const providerObject = (value: unknown): Record<string, unknown> => {
  const input = isRecord(value) ? value : {}
  const output: Record<string, unknown> = {}
  if (input.sort === "price" || input.sort === "throughput" || input.sort === "latency") output.sort = input.sort
  for (const key of ["only", "order"] as const) {
    const list = input[key]
    if (!Array.isArray(list)) continue
    const slugs = list.filter(
      (item): item is string => typeof item === "string" && item.length > 0 && !item.includes("/"),
    )
    if (slugs.length > 0) output[key] = slugs
  }
  for (const key of ["allow_fallbacks", "require_parameters", "zdr"] as const) {
    if (typeof input[key] === "boolean") output[key] = input[key]
  }
  for (const key of ["data_collection", "ignore"] as const) {
    const entry = input[key]
    if (typeof entry === "string" && entry.length > 0) output[key] = entry
  }
  if (Array.isArray(input.quantizations)) {
    const quantizations = input.quantizations.filter((item): item is string => typeof item === "string")
    if (quantizations.length > 0) output.quantizations = quantizations
  }
  if (isRecord(input.max_price)) output.max_price = input.max_price
  return output
}

const bodyOptions = (input: unknown) => {
  const openrouter = isRecord(input) ? input : {}
  const provider = providerObject(openrouter.provider)
  return {
    ...(openrouter.usage === true
      ? { usage: { include: true } }
      : isRecord(openrouter.usage)
        ? { usage: openrouter.usage }
        : {}),
    ...(isRecord(openrouter.reasoning) ? { reasoning: openrouter.reasoning } : {}),
    ...(typeof openrouter.promptCacheKey === "string" ? { prompt_cache_key: openrouter.promptCacheKey } : {}),
    ...(Object.keys(provider).length > 0 ? { provider } : {}),
  }
}

export const route = Route.make({
  id: ADAPTER,
  provider: profile.provider,
  protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: profile.baseURL }),
  framing: Framing.sse,
})

export const routes = [route]

const configuredRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return route.with({
    ...rest,
    endpoint: { baseURL: baseURL ?? profile.baseURL },
    auth: AuthOptions.bearer(input, "OPENROUTER_API_KEY"),
  })
}

export const configure = (input: ModelOptions = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model = provider.model
