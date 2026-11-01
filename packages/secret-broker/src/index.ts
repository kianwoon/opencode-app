// Secret Broker — real OpenCode v2 plugin (Plugin.Context domain services).
//
// Protection map (packages/plugin/src/promise/*):
//   shell.create.before                      -> inject allowlisted .env into a child env
//   tool.execute.before                      -> throw to block a call on a protected path
//   tool.execute.after (completed | error)   -> redact the model-visible result
//   session.context / session.compaction     -> redact every model-visible request
//
// `permission.ask` exists in neither API contract as a live trigger, so file
// protection is enforced through `tool.execute.before` only.
//
// Streaming sink: the plugin API exposes no per-chunk hook, so the model-visible
// channel is covered at the FINAL-RESULT boundaries that DO exist — the tool
// after-hook (success AND error) and the session context/compaction hooks, which
// run before every step and before compaction. A chunk-boundary-safe
// `StreamRedactor` already exists (redactor.ts, retain = longest-1) and is proven
// by the "split secret across two chunks" / "byte-by-byte" cases in
// secret-broker.test.ts; if OpenCode later adds a stream hook, wrap its sink with
// `new StreamRedactor(broker.redactor)`. Network exfiltration is out of scope
// (design §17).

import * as path from "node:path"
import { readFile, stat } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"
import { Allowlist } from "./allowlist.js"
import { audit } from "./audit.js"
import { bootstrap } from "./bootstrap.js"
import { parse } from "./env-loader.js"
import { check, denialMessage } from "./protection.js"
import { Redactor } from "./redactor.js"

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
    // Keep the last-good redactor and the last-good mtime: advancing either on a
    // read failure would leave the session unredacted with no audit trace.
    if (parsed.failed) return
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
  applyTo(target: Record<string, string | undefined>): void {
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

async function parseFile(file: string): Promise<{ values: ReadonlyMap<string, string>; malformed: readonly string[]; failed: boolean }> {
  // node:fs/promises (not Bun's file API) so this works in the desktop app's
  // Node sidecar, where the global `Bun` is undefined. A non-ENOENT failure is
  // reported, never swallowed as "empty": installing an empty redactor would
  // silently disable redaction for the rest of the session.
  const result = await readFile(file, "utf8").then(
    (text) => ({ text, failed: false as const }),
    (error: unknown) => ({ text: undefined, failed: (error as NodeJS.ErrnoException).code !== "ENOENT" }),
  )
  if (result.text === undefined) return { values: new Map<string, string>(), malformed: [], failed: result.failed }
  const parsed = parse(result.text)
  return { values: parsed.values, malformed: parsed.malformed, failed: false }
}

async function mtime(file: string): Promise<number | undefined> {
  const info = await stat(file).catch(() => undefined)
  return info?.mtimeMs
}

/** Placeholder used when redaction itself fails: withhold the text entirely. */
export const REDACTION_WITHHELD =
  "[secret-broker] redaction failed; output withheld to avoid leaking secrets."

/**
 * Fail-closed text redaction. If redaction itself throws, the withheld
 * placeholder is returned instead of the original text.
 */
export function redactErrorText(input: { broker: SecretBroker; text: string }): string {
  try {
    return input.broker.redact(input.text)
  } catch {
    return REDACTION_WITHHELD
  }
}

/** Builds a fail-closed replacement for a message whose redaction threw. The
 * in-place pass may have redacted some fields before a throwing accessor aborted
 * it, so we discard the ENTIRE message rather than trust a partial result. Only
 * `id`/`role` are read back — each guarded — to keep downstream projection
 * stable; every text-bearing field is dropped. */
function withheld(message: unknown): unknown {
  const read = <T>(pick: () => T): T | undefined => {
    try {
      return pick()
    } catch {
      return undefined
    }
  }
  const info = read(() => (message as { info?: { id?: unknown; role?: unknown } }).info)
  return {
    info: { id: read(() => info?.id), role: read(() => info?.role) },
    parts: [{ type: "text", text: REDACTION_WITHHELD }],
  }
}

/** Fail-closed replacement for a system part whose redaction threw. */
function withheldSystem(): { type: "text"; text: string } {
  return { type: "text", text: REDACTION_WITHHELD }
}

/** Redacts every model-visible message of a request IN PLACE. The host spreads
 *  the request (`{ ...draft, agent, tools }`) and then sends `messages`, so the
 *  array object is shared: element assignment is visible downstream while
 *  replacing the array is not. `system` parts are redacted the same way. */
function redactRequest(broker: SecretBroker, request: { messages: unknown[]; system: unknown[] }): void {
  for (let index = 0; index < request.messages.length; index++) {
    try {
      broker.redactInPlace(request.messages[index])
    } catch {
      // The in-place pass may have redacted some fields before a throwing
      // accessor aborted it, leaving a PARTIAL result. Discard the whole message
      // rather than forward any unredacted sibling field.
      request.messages[index] = withheld(request.messages[index])
    }
  }
  for (let index = 0; index < request.system.length; index++) {
    try {
      broker.redactInPlace(request.system[index])
    } catch {
      request.system[index] = withheldSystem()
    }
  }
}

/** Redacts a completed tool result IN PLACE: the host reads `result.output`,
 *  `result.content` and `result.metadata` off this same object afterwards. */
function redactResult(broker: SecretBroker, result: { output?: unknown; content?: unknown; metadata?: unknown }, report: (key: string) => void): void {
  if (typeof result.output === "string") Object.assign(result, { output: broker.redact(result.output, report) })
  const content = result.content
  if (typeof content === "string") {
    Object.assign(result, { content: broker.redact(content, report) })
  } else if (Array.isArray(content)) {
    Object.assign(result, {
      content: content.map((part: unknown) => {
        if (part === null || typeof part !== "object") return part
        const record = part as { type?: unknown; text?: unknown; uri?: unknown; name?: unknown }
        return Object.assign(part, {
          ...(typeof record.text === "string" ? { text: broker.redact(record.text, report) } : {}),
          ...(typeof record.uri === "string" ? { uri: broker.redact(record.uri, report) } : {}),
          ...(typeof record.name === "string" ? { name: broker.redact(record.name, report) } : {}),
        })
      }),
    })
  }
  if (result.metadata !== undefined) Object.assign(result, { metadata: broker.redactDeep(result.metadata) })
}

type FailurePayload = { message?: unknown; metadata?: unknown; error?: unknown }
type FailureConstructor = new (input: {
  message: string
  metadata?: unknown
  error?: unknown
}) => FailurePayload

/**
 * Redacts a failed tool result. A Schema class (`Tool.Error`) snapshots its
 * fields for encoding, so writing `message` in place is invisible to
 * JSON/Schema serialization — the original text would come back out of
 * `toJSON`. Rebuild the same class with redacted fields instead, so neither a
 * property read nor an encode can recover the secret.
 */
function redactFailure(broker: SecretBroker, error: FailurePayload, report: (key: string) => void): FailurePayload {
  const message = typeof error.message === "string" ? broker.redact(error.message, report) : error.message
  const metadata = error.metadata === undefined ? undefined : broker.redactDeep(error.metadata)
  // A nested defect (`Error.stack` especially) still carries the raw message, so
  // anything that logs the error would print the secret.
  const defect = error.error
  if (defect instanceof Error) {
    defect.message = broker.redact(defect.message, report)
    if (typeof defect.stack === "string") defect.stack = broker.redact(defect.stack, report)
  }
  try {
    const Rebuild = error.constructor as unknown as FailureConstructor
    return new Rebuild({
      message: typeof message === "string" ? message : String(message),
      ...(metadata === undefined ? {} : { metadata }),
      ...(defect === undefined ? {} : { error: defect }),
    })
  } catch {
    return { message, metadata, error: defect }
  }
}

function optionsOf(options: Readonly<Record<string, any>>): SecretBrokerOptions {
  return typeof options.minLength === "number" ? { minLength: options.minLength } : {}
}

/** The v2 plugin. `setup` receives the real `Plugin.Context`, so every
 *  protection is a registration on a host domain service — no hook map, no
 *  compatibility shim. Registrations are disposed when the plugin unloads. */
export const secretBrokerPlugin = Plugin.define({
  id: "opencode.secret-broker",
  async setup(context) {
    const broker = await SecretBroker.create(context.location.directory, optionsOf(context.options))

    const registrations = await Promise.all([
      context.shell.hook("create.before", async (event) => {
        // §25: refresh from disk immediately before the process launches.
        await broker.reload()
        broker.applyTo(event.env)
        // Metadata-only audit: names + ids, never values. ONE line per spawn — a
        // per-key line grew the only durable trace without bound.
        const keys = broker.injectedNames()
        if (keys.length > 0) audit({ action: "inject", keys, pid: process.pid })
      }),

      context.tool.hook("execute.before", (event) => {
        const denial = check(event.tool, event.input)
        if (!denial) return
        audit({
          action: "block",
          tool: denial.tool,
          filePath: denial.filePath,
          sessionID: event.sessionID,
          callID: event.id,
        })
        // A rejection from this hook fails the call before the tool runs.
        throw new Error(denialMessage(denial, broker.injectedNames()))
      }),

      context.tool.hook("execute.after", (event) => {
        const report = (key: string) =>
          audit({ action: "redact", key, tool: event.tool, sessionID: event.sessionID, callID: event.id })
        // Fail-closed (spec §31): if redaction throws we must never forward the
        // raw result. Replace it with a safe placeholder instead.
        try {
          if (event.status === "completed") redactResult(broker, event.result, report)
          else Object.assign(event, { error: redactFailure(broker, event.error, report) })
        } catch {
          if (event.status === "completed") Object.assign(event, { result: { output: REDACTION_WITHHELD } })
          else Object.assign(event, { error: { message: REDACTION_WITHHELD } })
        }
      }),

      // Model-visible safety net. The after-hook does not run for an ABORTED
      // tool, yet the live metadata streams to the model, so the transcript itself
      // is redacted before every step and before compaction — the lowest common
      // model-facing sink. Fail-closed per message.
      context.session.hook("context", (event) => redactRequest(broker, event)),
      context.session.hook("compaction", (event) => redactRequest(broker, event)),
    ])

    return () => Promise.all(registrations.map((registration) => registration.dispose())).then(() => undefined)
  },
})

export default secretBrokerPlugin

// Also expose the internals for focused tests / advanced wiring.
export { Allowlist } from "./allowlist.js"
export { audit } from "./audit.js"
export { bootstrap } from "./bootstrap.js"
export { parse, load, loadKeys } from "./env-loader.js"
export { check, denialMessage } from "./protection.js"
export { Redactor, StreamRedactor } from "./redactor.js"
