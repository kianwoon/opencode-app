// baseline-guard:dump new shared module — no prior artifact; the accidental-config-free five-tool call chain is what it replaces.
/**
 * The ONE resolution of "the jev model" shared by the five advisory tools.
 *
 * Config owner is `opencode.json` — the file Settings → Orchestration writes —
 * which is also what `session/prompt.ts` reads before routing a turn: the `jev`
 * block's `model`, else the shared `jevDefault.model`, else
 * `typesafe/jev-latest`. The effort-router's own `effort-router.json` `jev`
 * block belongs to that plugin and is never a second source of truth here.
 *
 * The transport follows the spec's provider prefix and the key is read from the
 * SAME provider namespace, because the typesafe and openrouter decisions
 * endpoints take different credentials. Keeping model, transport and key in one
 * value is what stops a configured model from being used with a foreign key.
 */
import { Config } from "../config.js"
import type { Entry } from "@opencode/schema/config"
import { jevModelFor, jevTransport, resolveJevModel, type JevTransport } from "./client.js"
import { jevKey } from "./controller.js"

export type JevToolCall = {
  /** The configured (or default) `provider/model` spec. */
  readonly model: string
  /** Wire transport, absent only when the spec names a provider that cannot answer. */
  readonly transport: JevTransport | undefined
  /** Credential for the transport's provider namespace. */
  readonly key: string | undefined
}

/**
 * Resolve the advisory tools' call target from live config entries. `keyFor` is
 * injectable only so tests can assert namespace matching without touching the
 * user's credentials.
 */
export const jevToolCall = (
  entries: readonly Entry[],
  keyFor: (provider: string) => string | undefined = jevKey,
): JevToolCall => {
  const model = resolveJevModel(
    jevModelFor(Config.latest(entries, "jev")?.model, Config.latest(entries, "jevDefault")?.model),
    keyFor,
  ).spec
  const transport = jevTransport(model)
  return { model, transport, key: transport ? keyFor(transport.provider) : undefined }
}
