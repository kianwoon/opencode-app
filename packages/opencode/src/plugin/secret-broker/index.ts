// Secret Broker MVP — real OpenCode plugin hooks (no fictional ctx.shell.hook).
//
// Hook contract (packages/plugin/src/index.ts):
//   shell.env            (input, output {env})  -> mutate output.env in place
//   tool.execute.before  (input, output {args}) -> throw to block
//   tool.execute.after   (input, output {title,output,metadata}) -> mutate to redact
//
// `permission.ask` has no plugin trigger call sites — file and install
// protection is enforced through tool.execute.before plus the live tool-side
// ctx.ask in tool/shell.ts, not through this hook.
//
// Streaming sink (P2-j): the plugin API exposes no per-chunk stream hook, so the
// model-visible channel is covered at the FINAL-RESULT boundaries that DO exist —
// `tool.execute.after` (success), `redactOnFailure` (thrown tools), and
// `experimental.chat.messages.transform` (before every step + compaction). A
// chunk-boundary-safe `StreamRedactor` already exists (redactor.ts, retain =
// longest-1) and is proven by the "split secret across two chunks" /
// "byte-by-byte" cases in secret-broker.test.ts; if OpenCode later adds a stream
// hook, wrap its sink with `new StreamRedactor(broker.redactor)` with no other
// change. Network exfiltration is explicitly out of scope (design §17).

import * as path from "node:path"
import { readFile, stat } from "node:fs/promises"
import { Cause, Effect } from "effect"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Plugin } from "@/plugin"
import { errorMessage } from "@/util/error"
import { Allowlist } from "./allowlist"
import { audit } from "./audit"
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
 * Holds the per-directory broker state. The allowlist is frozen from the startup
 * snapshot so mid-session edits to `.env.example` never WIDEN what gets injected
 * (Threat F) — `reload` can only shrink/refresh, never add keys. Values are
 * re-read when `.env`'s mtime changes (design §25 option 2, P1-b).
 */
export class SecretBroker {
  private allowlist: Allowlist
  private redactor: Redactor
  private injected: ReadonlyMap<string, string>
  private missing: readonly string[]
  private malformed: readonly string[]
  /** Session-frozen key set: reload may never expand injection beyond this. */
  private readonly baseline: ReadonlySet<string>
  private readonly envPath: string
  private readonly examplePath: string
  private readonly minLength: number
  private envMtime: number | undefined
  private exampleMtime: number | undefined

  private constructor(
    state: {
      allowlist: Allowlist
      redactor: Redactor
      injected: ReadonlyMap<string, string>
      missing: readonly string[]
      malformed: readonly string[]
      baseline: ReadonlySet<string>
    },
    paths: { envPath: string; examplePath: string; minLength: number; envMtime?: number; exampleMtime?: number },
  ) {
    this.allowlist = state.allowlist
    this.redactor = state.redactor
    this.injected = state.injected
    this.missing = state.missing
    this.malformed = state.malformed
    this.baseline = state.baseline
    this.envPath = paths.envPath
    this.examplePath = paths.examplePath
    this.minLength = paths.minLength
    this.envMtime = paths.envMtime
    this.exampleMtime = paths.exampleMtime
  }

  static async create(
    directory: string,
    options: SecretBrokerOptions = {},
  ): Promise<SecretBroker> {
    const minLength = options.minLength ?? 8
    const envPath = path.join(directory, ENV_FILE)
    const examplePath = path.join(directory, EXAMPLE_FILE)

    await bootstrap(envPath, examplePath)

    const allowlist = await Allowlist.snapshot(examplePath)
    // Baseline frozen at startup (Threat F / design §29).
    const baseline = new Set(allowlist.names())
    const parsed = await parseFile(envPath)
    const derived = derive(allowlist, parsed.values, minLength)
    const broker = new SecretBroker(
      { allowlist, ...derived, malformed: parsed.malformed, baseline },
      {
        envPath,
        examplePath,
        minLength,
        envMtime: await mtime(envPath),
        exampleMtime: await mtime(examplePath),
      },
    )
    broker.reportStartup()
    return broker
  }

  /** §25 reload: stat `.env`/`.env.example`; if either mtime changed, re-parse
   *  and REBUILD the redactor + allowlist + injected map. Called immediately
   *  before every shell spawn, so a value edited in `.env` refreshes and a newly
   *  added value becomes redactable on the next process launch. The allowlist is
   *  re-derived against the session baseline, so an edit can never expand it. */
  async reload(): Promise<void> {
    const envMtime = await mtime(this.envPath)
    const exampleMtime = await mtime(this.examplePath)
    if (envMtime === this.envMtime && exampleMtime === this.exampleMtime) return

    const parsed = await parseFile(this.envPath)
    await this.allowlist.refresh(this.examplePath, this.baseline)
    const derived = derive(this.allowlist, parsed.values, this.minLength)
    this.redactor = derived.redactor
    this.injected = derived.injected
    this.missing = derived.missing
    this.malformed = parsed.malformed
    this.envMtime = envMtime
    this.exampleMtime = exampleMtime
    this.reportStartup()
  }

  private reportStartup(): void {
    audit({
      action: "startup",
      allowlisted: this.allowlist.size,
      injected: this.injected.size,
      missing: this.missing,
      malformed: this.malformed,
    })
  }

  /** Allowlisted values present, injected verbatim. */
  shellEnv(): Record<string, string> {
    return Object.fromEntries(this.injected)
  }

  /** Injected secret KEY NAMES only (never values), sorted. Used to tell a
   *  blocked agent which `$NAME`s it can reference in shell commands. */
  injectedNames(): string[] {
    return [...this.injected.keys()].sort()
  }

  /** Applies broker values onto a child env object (P1-c precedence, design §22:
   *  protected allowlisted keys are OVERWRITTEN by the broker; every other
   *  pre-existing key in `target` is left untouched, so a user's non-secret
   *  environment wins for anything the broker does not manage). Values are
   *  allowlisted-only, so this can never inject an undeclared key. */
  applyTo(target: Record<string, string>): void {
    for (const [key, value] of this.injected) target[key] = value
  }

  /** Non-secret diagnostic: counts + key NAMES only. */
  diagnostics(): {
    allowlisted: number
    injected: number
    missing: readonly string[]
    malformed: readonly string[]
    names: readonly string[]
  } {
    return {
      allowlisted: this.allowlist.size,
      injected: this.injected.size,
      missing: this.missing,
      malformed: this.malformed,
      names: this.allowlist.names(),
    }
  }

  /** Redacts and reports each redacted key NAME (metadata-only audit). */
  redact(input: string, report?: (key: string) => void): string {
    return this.redactor.redact(input, report)
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

type Derived = {
  redactor: Redactor
  injected: ReadonlyMap<string, string>
  missing: readonly string[]
}

/** Builds the redactor (EVERY parsed value) and the injected map (allowlisted
 *  values only) from a raw `KEY -> value` map. Values are never logged. */
function derive(allowlist: Allowlist, declared: ReadonlyMap<string, string>, minLength: number): Derived {
  const { env, missing } = allowlist.select(declared, 1)
  const redactable = [...declared.entries()]
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => ({ key, value }))
  return { redactor: new Redactor(redactable, minLength), injected: new Map(Object.entries(env)), missing }
}

async function parseFile(file: string): Promise<{ values: ReadonlyMap<string, string>; malformed: readonly string[] }> {
  // node:fs/promises (not Bun's file API) so this works in the desktop app's
  // Node sidecar, where the global `Bun` is undefined.
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return { values: new Map<string, string>(), malformed: [] }
  const parsed = parse(text)
  return { values: parsed.values, malformed: parsed.malformed }
}

async function mtime(file: string): Promise<number | undefined> {
  const info = await stat(file).catch(() => undefined)
  return info?.mtimeMs
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
    "shell.env": async (hookInput, output) => {
      // §25: refresh from disk immediately before the process launches.
      await broker.reload()
      broker.applyTo(output.env)
      // Metadata-only audit: names + ids, never values.
      for (const key of Object.keys(broker.shellEnv())) {
        audit({ action: "inject", key, pid: process.pid, sessionID: hookInput.sessionID, callID: hookInput.callID })
      }
    },

    "tool.execute.before": async (hookInput, output) => {
      const denial = check(hookInput.tool, output.args)
      if (!denial) return
      audit({
        action: "block",
        tool: denial.tool,
        filePath: denial.filePath,
        sessionID: hookInput.sessionID,
        callID: hookInput.callID,
      })
      throw new Error(denialMessage(denial, broker.injectedNames()))
    },

    "tool.execute.after": async (hookInput, output) => {
      // Fail-closed (spec §31): if redaction throws we must never forward the
      // raw output. Replace with a safe placeholder instead.
      const report = (key: string) =>
        audit({ action: "redact", key, tool: hookInput.tool, sessionID: hookInput.sessionID, callID: hookInput.callID })
      try {
        if (typeof output.output === "string") output.output = broker.redact(output.output, report)
        if (typeof output.title === "string") output.title = broker.redact(output.title, report)
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
export { audit } from "./audit"
export { bootstrap } from "./bootstrap"
export { parse, load, loadKeys } from "./env-loader"
export { check, denialMessage } from "./protection"
export { Redactor, StreamRedactor } from "./redactor"
