// Minimal structural replacement for `@/plugin`'s `Plugin.Interface` /
// `Plugin.Service`. The standalone package cannot import the host's internal
// module graph, and these members are only needed to *type* and *wire* the
// redaction helpers used by callers that hold a live plugin handle. The real
// host service is injected at runtime, so `Service.of` is a plain constructor.

import type { Hooks } from "@opencode-ai/plugin"
import type { Effect } from "effect"

/** Hook names that follow the `(input, output) => Promise<void>` trigger shape. */
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export namespace Plugin {
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

  /** Structural stand-in for the host's `Context.Service` constructor. */
  export const Service = {
    of: (impl: Interface): Interface => impl,
  }
}
