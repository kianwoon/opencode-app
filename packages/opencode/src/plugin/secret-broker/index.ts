// Secret Broker MVP — real OpenCode plugin hooks (no fictional ctx.shell.hook).
//
// Hook contract (packages/plugin/src/index.ts):
//   shell.env            (input, output {env})  -> mutate output.env in place
//   tool.execute.before  (input, output {args}) -> throw to block
//   tool.execute.after   (input, output {title,output,metadata}) -> mutate to redact
//
// `permission.ask` is DECLARED but DEAD (no trigger call sites) — file
// protection is enforced through tool.execute.before instead.

import * as path from "node:path"
import { readFile } from "node:fs/promises"
import { Cause, Effect } from "effect"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Plugin } from "@/plugin"
import { errorMessage } from "@/util/error"
import { Allowlist } from "./allowlist"
import { bootstrap } from "./bootstrap"
import { parse } from "./env-loader"
import { check, denialMessage } from "./protection"
import { Redactor } from "./redactor"

export type SecretBrokerOptions = {
  /** Minimum value length eligible for redaction/injection. Default 8. */
  minLength?: number
}

const ENV_FILE = ".env"
const EXAMPLE_FILE = ".env.example"

/**
 * Holds the per-directory broker state. The allowlist and redactor are frozen
 * from the startup snapshot so mid-session edits to .env(.example) never widen
 * what gets injected (Threat F).
 */
export class SecretBroker {
  private constructor(
    private readonly allowlist: Allowlist,
    private readonly redactor: Redactor,
    /** Allowlist-filtered values captured at startup; the ONLY source injected
     *  into shell.env, so an undeclared key can never leak into the child
     *  environment even if filter logic drifts. Missing allowlisted keys are
     *  simply absent. Note the REDACTOR is built from a wider set (every parsed
     *  .env value), so a non-allowlisted value is never injected yet still
     *  cannot surface through tool output. */
    private readonly injected: ReadonlyMap<string, string>,
    private readonly missing: readonly string[],
  ) {}

  static async create(
    directory: string,
    options: SecretBrokerOptions = {},
  ): Promise<SecretBroker> {
    const minLength = options.minLength ?? 8
    const envPath = path.join(directory, ENV_FILE)
    const examplePath = path.join(directory, EXAMPLE_FILE)

    await bootstrap(envPath, examplePath)

    const allowlist = await Allowlist.snapshot(examplePath)
    const parsed = await readIfExists(envPath)
    const declared = parsed ?? new Map<string, string>()
    // Every non-empty value is injected regardless of length: a short secret is
    // still a credential, and the redactor now covers short values with
    // key-anchored + word-boundary matching, so it is never unredactable. Only
    // length-0 (unset) values are withheld.
    const { env, missing } = allowlist.select(declared, 1)

    // INJECTION is allowlisted-only (threat F): only `env` reaches shell.env.
    // REDACTION covers EVERY parsed .env value, so an undeclared secret (e.g.
    // `cat .env` echoed through a tool result) is rewritten to its
    // `secret://project/KEY` handle even though it is never injected. Values
    // >= `minLength` get exact + encoded matching; shorter values get
    // key-anchored + word-boundary matching to avoid false positives.
    const redactable = [...declared.entries()]
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => ({ key, value }))
    const injected = new Map(Object.entries(env))
    return new SecretBroker(allowlist, new Redactor(redactable, minLength), injected, missing)
  }

  /** Allowlisted values present at startup, injected verbatim. */
  shellEnv(): Record<string, string> {
    return Object.fromEntries(this.injected)
  }

  /** Non-secret diagnostic: names of allowlisted keys that were unset. */
  diagnostics(): { allowlisted: number; missing: readonly string[] } {
    return { allowlisted: this.allowlist.size, missing: this.missing }
  }

  redact(input: string): string {
    return this.redactor.redact(input)
  }

  redactDeep<T>(value: T): T {
    return this.redactor.redactDeep(value)
  }

  /** Redacts strings in place, preserving object identity/prototypes. Used on
   *  model messages, whose parts/errors must not be re-hydrated as plain objects. */
  redactInPlace<T>(value: T): T {
    return this.redactor.redactInPlace(value)
  }
}

async function readIfExists(file: string): Promise<ReadonlyMap<string, string> | undefined> {
  // node:fs/promises (not Bun's file API) so this works in the desktop app's
  // Node sidecar, where the global `Bun` is undefined.
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  return parse(text).values
}

/** Placeholder used when redaction itself fails: withhold the text entirely. */
export const REDACTION_WITHHELD =
  "[secret-broker] redaction failed; output withheld to avoid leaking secrets."

/**
 * Runs `tool.execute.after` (redaction) over an arbitrary text payload and
 * returns the redacted result. Fail-closed: if redaction itself throws, the
 * withheld placeholder is returned instead of the original text.
 */
export const redactErrorText = (input: {
  plugin: Plugin.Interface
  tool: string
  sessionID: string
  callID: string
  args: unknown
  text: string
}): Effect.Effect<string> => {
  const redacted = { title: "", output: input.text, metadata: {} as Record<string, unknown> }
  return input.plugin
    .trigger(
      "tool.execute.after",
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: input.args },
      redacted,
    )
    .pipe(
      Effect.catchCause(() =>
        Effect.sync(() => {
          redacted.output = REDACTION_WITHHELD
        }),
      ),
      Effect.map(() => redacted.output),
    )
}

/**
 * Secret Broker, shared across every tool invocation path: `tool.execute.after`
 * (redaction) must run even when the tool THROWS, otherwise a secret embedded
 * in an error message reaches the model unredacted. Routes the error text
 * through the same after-hook, then fails with the ORIGINAL cause (identity,
 * hence RejectedError control-flow, is preserved) whose message carries the
 * redacted text. Fail-closed via {@link redactErrorText}. Interrupt-only causes
 * pass through untouched so cancellation semantics hold.
 */
export const redactOnFailure = (input: {
  plugin: Plugin.Interface
  tool: string
  sessionID: string
  callID: string
  args: unknown
  cause: Cause.Cause<unknown>
}): Effect.Effect<never, unknown> => {
  const { cause } = input
  if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
  const error = Cause.squash(cause)
  const original = errorMessage(error)
  return redactErrorText({ ...input, text: original }).pipe(
    Effect.flatMap((output) => {
      if (output === original) return Effect.failCause(cause)
      if (error instanceof Error) {
        error.message = output
        return Effect.failCause(cause)
      }
      return Effect.fail(output)
    }),
  )
}

/**
 * Builds a fail-closed replacement for a message whose redaction threw. The
 * in-place pass may have redacted some fields before a throwing accessor aborted
 * it, so we discard the ENTIRE message rather than trust a partial result. Only
 * `id`/`role` are read back — each guarded — to keep downstream projection
 * stable; every text-bearing field is dropped.
 */
function withheld(message: { info: unknown; parts: unknown[] }): typeof message {
  const read = <T>(pick: () => T): T | undefined => {
    try {
      return pick()
    } catch {
      return undefined
    }
  }
  const info = read(() => message.info) as { id?: unknown; role?: unknown } | undefined
  return {
    info: { id: read(() => info?.id), role: read(() => info?.role) },
    parts: [{ type: "text", text: REDACTION_WITHHELD }],
  } as unknown as typeof message
}

/** Builds the plugin Hooks. Resolves a broker lazily per instance directory so
 *  a missing .env is a clean no-op and commands behave exactly as before. */
export async function secretBrokerPlugin(
  input: PluginInput,
  options: SecretBrokerOptions = {},
): Promise<Hooks> {
  const broker = await SecretBroker.create(input.directory, options)

  return {
    "shell.env": async (_input, output) => {
      Object.assign(output.env, broker.shellEnv())
    },

    "tool.execute.before": async (hookInput, output) => {
      const denial = check(hookInput.tool, output.args)
      if (denial) throw new Error(denialMessage(denial))
    },

    "tool.execute.after": async (_hookInput, output) => {
      // Fail-closed (spec §31): if redaction throws we must never forward the
      // raw output. Replace with a safe placeholder instead.
      try {
        if (typeof output.output === "string") output.output = broker.redact(output.output)
        if (typeof output.title === "string") output.title = broker.redact(output.title)
        if (output.metadata !== undefined) output.metadata = broker.redactDeep(output.metadata)
      } catch {
        output.output = "[secret-broker] redaction failed; output withheld to avoid leaking secrets."
        output.title = "[secret-broker] output withheld"
        output.metadata = undefined
      }
    },

    // Model-visible safety net. `tool.execute.after` never runs for an ABORTED
    // tool, yet `processor.ts` streams live `metadata.output` and, on interrupt,
    // marks `metadata.interrupted` — which `message-v2.ts` then projects to the
    // MODEL as a normal tool result. So a secret in the live shell/command
    // output would reach the model unredacted. This hook is the lowest common
    // model-facing sink: it runs BEFORE `toModelMessagesEffect` on every step
    // (prompt.ts) and before compaction (compaction.ts), so it redacts every
    // message part — tool output, metadata, error text and tool-call args — in
    // place, preserving object identity. Fail-closed: if redaction throws we
    // replace the WHOLE message with a withheld placeholder — never a partial
    // result — rather than forward raw content.
    "experimental.chat.messages.transform": async (_hookInput, output) => {
      for (let index = 0; index < output.messages.length; index++) {
        const message = output.messages[index]
        try {
          broker.redactInPlace(message)
        } catch {
          // The in-place pass may have redacted some fields before a throwing
          // accessor aborted it, leaving a PARTIAL result. Discard the whole
          // message (parts + info/metadata redacted-so-far) rather than forward
          // any unredacted sibling field. Success path keeps object identity.
          output.messages[index] = withheld(message as { info: unknown; parts: unknown[] }) as typeof message
        }
      }
    },
  }
}

export default secretBrokerPlugin

// Also expose the internals for focused tests / advanced wiring.
export { Allowlist } from "./allowlist"
export { bootstrap } from "./bootstrap"
export { parse, load, loadKeys } from "./env-loader"
export { check, denialMessage } from "./protection"
export { Redactor } from "./redactor"
