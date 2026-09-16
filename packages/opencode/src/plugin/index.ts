import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { ModalPlugin } from "./modal/modal"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { CerebrasPlugin } from "./cerebras"
import { SnowflakeCortexAuthPlugin } from "./snowflake-cortex"
import { secretBrokerPlugin as SecretBrokerPlugin } from "./secret-broker"
import { executionGuardPlugin as ExecutionGuardPlugin } from "./execution-guard"
import { contextFirewallPlugin as ContextFirewallPlugin } from "./context-firewall"
import { Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { pluginSpecifier } from "@/config/plugin"
import type { Origin as ConfigPluginOrigin } from "@/config/plugin"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

type State = {
  hooks: Hooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

// A user may wire the standalone `opencode-secret-broker` package (npm name or
// file:// path) into `plugin[]` in addition to the built-in. Both expose the same
// hooks (shell.env injection, tool.execute redaction, messages.transform), so
// running both double-injects and double-redacts. Match either the published
// package name or any path segment containing `secret-broker`.
export function isStandaloneSecretBrokerSpec(spec: string): boolean {
  return /secret-broker/i.test(spec)
}

function hasStandaloneSecretBroker(origins: readonly ConfigPluginOrigin[]): boolean {
  return origins.some((origin) => isStandaloneSecretBrokerSpec(pluginSpecifier(origin.spec)))
}

// The single-broker decision: the built-in loads only when neither the opt-out
// flag nor a standalone plugin[] entry is present.
export function shouldLoadBuiltinSecretBroker(input: {
  disableSecretBroker: boolean
  pluginOrigins: readonly ConfigPluginOrigin[]
}): boolean {
  if (input.disableSecretBroker) return false
  return !hasStandaloneSecretBroker(input.pluginOrigins)
}

let warnedStandaloneSecretBroker = false
function warnStandaloneSecretBrokerOnce() {
  if (warnedStandaloneSecretBroker) return
  warnedStandaloneSecretBroker = true
  console.warn("[secret-broker] standalone secret-broker detected in plugin[]; built-in yielding to avoid double-load")
}

// Built-in plugins that are directly imported (not installed from npm). These
// register BEFORE external plugin[] entries.
export function internalPlugins(flags: RuntimeFlags.Info, standaloneSecretBroker: boolean): PluginInstance[] {
  if (standaloneSecretBroker) warnStandaloneSecretBrokerOnce()
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    (input) =>
      CodexAuthPlugin(input, {
        experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
      }),
    CopilotAuthPlugin,
    ModalPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    AzureAuthPlugin,
    DigitalOceanAuthPlugin,
    SnowflakeCortexAuthPlugin,
    XaiAuthPlugin,
    CerebrasPlugin,
    // Secret Broker: enabled by default (protects .env files and redacts secrets
    // from tool I/O). Opt out with OPENCODE_DISABLE_SECRET_BROKER. When the user
    // also wires the standalone broker into plugin[], the built-in yields so only
    // one broker is ever active.
    ...(flags.disableSecretBroker || standaloneSecretBroker ? [] : [SecretBrokerPlugin]),
    // Context Firewall (plan §4): tagging + neutralizing untrusted content so it
    // can never grant authority at the model sink. Independent of the broker.
    ...(flags.disableContextFirewall ? [] : [ContextFirewallPlugin]),
  ]
}

// Execution Guard MUST register after every secret broker, including a standalone
// broker wired via plugin[] (loaded after built-ins). Its `shell.env` deletes the
// broker's injected keys for zero-secret command classes (install/build/test), so
// registering it earlier would see an empty output.env and strip nothing. Ordering
// between its before-hook and the broker's before-hook is irrelevant: both deny
// independently and a throw still aborts execution. Co-gated with the broker (no
// broker keys to strip without it) and opt-out via OPENCODE_DISABLE_EXECUTION_GUARD.
export function tailInternalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return flags.disableSecretBroker || flags.disableExecutionGuard ? [] : [ExecutionGuardPlugin]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  // A single bad export (DEFAULTS object, `export * as X` namespace, helper fn without
  // a server field) must not fail the whole module — skip it and keep the valid plugins.
  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) continue
    result.push(plugin)
  }

  return result
}

async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return
  }

  const legacy = getLegacyPlugins(load.mod)
  if (!legacy.length) throw new Error(`Plugin ${load.spec} exposes no plugin exports`)
  for (const server of legacy) {
    hooks.push(await server(input, load.options))
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        const standaloneSecretBroker = hasStandaloneSecretBroker(cfg.plugin_origins ?? [])
        for (const plugin of flags.disableDefaultPlugins ? [] : internalPlugins(flags, standaloneSecretBroker)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.option,
          )
          if (init._tag === "Some") hooks.push(init.value)
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks),
            catch: (err) => {
              const message = errorMessage(err)
              return message
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error })),
            Effect.catch((message) =>
              Effect.sync(() => {
                publishPluginError(`Failed to load plugin ${load.spec}: ${message}`)
              }),
            ),
          )
        }

        // Execution Guard registers after external plugins (standalone broker) so its
        // shell.env sees broker-injected env; see tailInternalPlugins.
        for (const plugin of flags.disableDefaultPlugins ? [] : tailInternalPlugins(flags)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.option,
          )
          if (init._tag === "Some") hooks.push(init.value)
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () => Promise.resolve(hook.dispose?.()),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        return { hooks }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Config.node, RuntimeFlags.node],
})

export * as Plugin from "."
