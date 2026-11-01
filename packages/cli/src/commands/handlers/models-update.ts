// baseline-guard:allow new file created by this task; no prior baseline exists
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { ModelsDev } from "@opencode/core/models-dev"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { databasePath } from "../../database-path"
import { errorMessage } from "../../util/error"

const signed = (value: number) => (value > 0 ? `+${value}` : String(value))
const delta = (previous: number, current: number) => signed(current - previous)

/**
 * `opencode models update` — force a models.dev refetch and rewrite the catalog
 * cache. The v2 cache is the SQLite KV row `models-dev:v2:catalog` in the app
 * database (not a standalone models.json): the write is a single-row upsert, so a
 * reader sees either the old catalog or the new one, never a partial file, and a
 * failed fetch/decode writes nothing at all. Running servers keep the catalog
 * they loaded at startup until they restart.
 */
export default Runtime.handler(
  Commands.commands.models.commands.update,
  Effect.fn("cli.models.update")(function* () {
    const global = yield* Global.Service
    const path = databasePath(global.data)
    const layer = AppNodeBuilder.build(LayerNode.group([ModelsDev.node]), [
      Database.node.replace(Database.configured({ path })),
    ])
    const result = yield* ModelsDev.Service.use((service) => service.update()).pipe(
      Effect.provide(layer),
      Effect.mapError((error) => new Error(`models update failed: ${errorMessage(error).slice(0, 300)}`)),
    )

    const openrouter = result.changed.find((entry) => entry.provider === "openrouter")
    const others = result.changed.filter((entry) => entry.provider !== "openrouter").slice(0, 5)
    const lines = [
      "models.dev catalog updated",
      `models: ${result.previous.models} -> ${result.current.models} (${delta(result.previous.models, result.current.models)})`,
      `providers: ${result.previous.providers} -> ${result.current.providers} (${delta(result.previous.providers, result.current.providers)})`,
      `openrouter: ${openrouter ? `${openrouter.previous} -> ${openrouter.current} (${delta(openrouter.previous, openrouter.current)})` : "unchanged"}`,
      ...others.map(
        (entry) => `${entry.provider}: ${entry.previous} -> ${entry.current} (${delta(entry.previous, entry.current)})`,
      ),
      `cache: ${path} (kv models-dev:v2:catalog)`,
      `written: ${new Date(result.updatedAt).toISOString()}`,
      "Restart running servers to pick up the new catalog.",
    ]
    process.stdout.write(lines.join(EOL) + EOL)
  }),
)
