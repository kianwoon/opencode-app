// Real v2 host harness for the Secret Broker tests.
//
// Nothing here re-implements plugin wiring: the plugin is registered by
// `fromPromise(secretBrokerPlugin)` — the adapter `PluginModule` uses to run a
// `Plugin.define({ id, setup })` module — against `PluginHost.make`, and every
// assertion drives a hook through `PluginHooks.trigger` or a real tool execution
// through `Tool.snapshot`. The shared `Scope` keeps the registrations alive for
// the whole test and `close()` disposes them like an unload.

import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Effect, Exit, ManagedRuntime, Scope } from "effect"
import { Location } from "../../../core/src/location"
import { Plugin } from "../../../core/src/plugin"
import { PluginHost } from "../../../core/src/plugin/host"
import { PluginHooks } from "../../../core/src/plugin/hooks"
import { Tool } from "../../../core/src/tool"
import { PluginTestLayer } from "../../../core/test/plugin/fixture"
import { secretBrokerPlugin } from "../../src/index"

export type Harness = Awaited<ReturnType<typeof open>>

/** Opens the real host for one test and always disposes it afterwards. */
export async function withBroker<A>(seed: (directory: string) => void, body: (harness: Harness) => Promise<A>) {
  const harness = await open({ seed })
  try {
    return await body(harness)
  } finally {
    await harness.close()
  }
}

/** Opens the real host, seeds the project directory, and runs the plugin setup. */
export async function open(options: { seed?: (directory: string) => void } = {}) {
  const runtime = ManagedRuntime.make(PluginTestLayer)
  const scope = await runtime.runPromise(Scope.make())
  const withScope = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
    effect.pipe(Effect.provideService(Scope.Scope, scope))
  const directory = await runtime.runPromise(
    withScope(
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const location = yield* Location.Service
        options.seed?.(location.directory)
        yield* fromPromise(secretBrokerPlugin).effect(yield* PluginHost.make(plugins))
        return location.directory
      }),
    ),
  )
  const hooks = await runtime.runPromise(PluginHooks.Service)
  const tools = await runtime.runPromise(Tool.Service)
  return {
    directory,
    runtime,
    run: <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => runtime.runPromise(withScope(effect)),
    /** Dispatches one hook through the host's real registry. */
    trigger: <Domain extends keyof PluginHooks.Domains, Name extends keyof PluginHooks.Domains[Domain]>(
      domain: Domain,
      name: Name,
      event: PluginHooks.Domains[Domain][Name],
    ) => runtime.runPromise(hooks.trigger(domain, name, event) as Effect.Effect<unknown, unknown>),
    /** Registers a probe tool through the real Tool service, in the shared scope. */
    addTool: (tool: any) => runtime.runPromise(withScope(tools.transform((editor) => editor.add(tool)))),
    /** Executes a tool call through the real tool engine (after-hooks apply). */
    execute: (input: Parameters<Tool.Snapshot["execute"]>[0]) =>
      runtime.runPromise(tools.snapshot().pipe(Effect.flatMap((snapshot) => snapshot.execute(input)))),
    executeExit: (input: Parameters<Tool.Snapshot["execute"]>[0]) =>
      runtime.runPromise(
        tools.snapshot().pipe(Effect.flatMap((snapshot) => snapshot.execute(input)), Effect.exit),
      ),
    close: async () => {
      await runtime.runPromise(Scope.close(scope, Exit.void))
      await runtime.dispose()
    },
  }
}
