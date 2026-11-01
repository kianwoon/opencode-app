/**
 * Legacy hooks adapter — runs a v1 `Hooks` object under the v2 plugin contract.
 *
 * A v2 plugin default-exports `{ id, setup: async (ctx) => cleanup }`
 * (packages/core/src/plugin/module.ts). The v1 surface this adapter accepts is
 * what the ten ported plugins in `plugins/` were written against:
 *
 *   - `tool.execute.before(input, output)`  → v2 `ctx.tool.hook("execute.before")`
 *   - `tool.execute.after(input, output)`   → v2 `ctx.tool.hook("execute.after")`
 *   - `event({ event })`                    → v2 `ctx.event.subscribe()` loop
 *   - `tool` (custom tool map)              → v2 `ctx.tool.transform((editor) => editor.add(...))`
 *
 * Payload translation (verified against packages/schema/src/event.ts,
 * packages/plugin/src/promise/tool.ts, packages/core/src/tool.ts):
 *   - event `properties` → `data`
 *   - tool input `callID` → `id`
 *   - tool args: v2 write/edit carry `path`; the plugin-lib cores read the v1
 *     `filePath`, so the before/after hooks receive a merged view.
 *
 * TRANSLATED (message-model seam — v1 `{info,parts}[]` ⇄ v2 AI-SDK messages):
 *   - `chat.message`                        → v2 `ctx.session.hook("prompt")`
 *   - `chat.params`                         → v2 `ctx.session.hook("context")`
 *     (mutates `options`, the request field that reaches generation settings;
 *     `model.request` carries no options and would drop every write)
 *   - `experimental.chat.system.transform`  → v2 `ctx.session.hook("context")`
 *     (`system[0]` is the rendered instructions part, written back in place)
 *   - `experimental.chat.messages.transform`→ v2 `ctx.session.hook("context")`
 *   - `experimental.session.compacting`     → v2 `ctx.session.hook("compaction")`
 *     (pushed context strings become trailing system parts)
 *     The legacy hook sees a `{ info: { role, sessionID, providerID }, parts }`
 *     VIEW of the AI-SDK messages and mutates that view. Appended text parts
 *     become trailing `text` content blocks; a part REPLACED by a text part
 *     (the image bridge) replaces the original content block. A replaced slot
 *     keeps the original message's prototype, so it stays a real `Message`.
 *   - `config` — no v2 hook: a plugin reads its own config file at setup.
 *
 * NO v2 EQUIVALENT (degraded loudly, one `console.warn` per legacy key):
 *   - `permission.ask` — v2 replaced the interactive ask with
 *     `permission.evaluate(evaluation)`, which mutates `effect` on a static
 *     evaluation instead of returning `{ status }`. A faithful mapping does not
 *     exist; a plugin that needs to decide approvals must be rewritten against
 *     `permission.evaluate`. TODO(port)
 *   - `shell.env` — the working directory is `ctx.location.directory`. TODO(port)
 *   - `auth` — v2 has no plugin auth hook (credentials belong to providers).
 *     TODO(port)
 *   - `experimental.*` v1 hooks without a translation above
 *     (`chat.headers`, `session.compacting`, ...) — no v2 counterpart under
 *     those names. TODO(port)
 *
 * Non-hook v1 `PluginInput` fields (`client`, `directory`, `worktree`,
 * `$`, `app`) are mapped onto the v2 ctx: `client.session.messages` is rebuilt
 * from `ctx.session.context`, `directory` from `ctx.location.directory`.
 * `$` (Bun shell) has no ctx equivalent and is not provided.
 */

/**
 * No runtime dependency on the v1 package: a v1 tool's `args` record holds zod
 * fields, and every zod field already implements StandardSchemaV1 with a JSON
 * Schema projection, which the v2 runtime accepts directly. Building the object
 * schema from those fields (instead of `z.object(...)`) keeps the plugin's own
 * zod copy authoritative, including field descriptions and checks.
 */


export interface LegacyToolHookInput {
  tool: string
  sessionID: string
  callID: string
  agent?: string
}

export interface LegacyToolHookOutput {
  args: unknown
  output?: unknown
  metadata?: Record<string, unknown>
  title?: string
}

/** The v1 `execute` context the adapter supplies: directory + abort, plus the v2 tool context. */
export interface LegacyToolContext {
  sessionID: string
  directory?: string
  signal?: AbortSignal
  abort?: AbortSignal
  [key: string]: unknown
}

export interface LegacyToolDefinition {
  description?: string
  args?: Record<string, unknown>
  execute: (args: Record<string, unknown>, context: LegacyToolContext) => Promise<unknown> | unknown
}

export interface LegacyModel {
  providerID?: string
  id?: string
  modelID?: string
  capabilities: { reasoning?: boolean; [key: string]: unknown }
  [key: string]: unknown
}

/** A v1 `{ info, parts }` message, projected from (and written back to) an AI-SDK message. */
export interface LegacyMessage {
  info?: { role?: string; sessionID?: string; providerID?: string }
  role?: string
  parts: Array<Record<string, unknown>>
}

export interface LegacyHooks {
  "tool.execute.before"?: (input: LegacyToolHookInput, output: LegacyToolHookOutput) => Promise<void> | void
  "tool.execute.after"?: (input: LegacyToolHookInput, output: LegacyToolHookOutput) => Promise<void> | void
  "chat.message"?: (
    input: { sessionID: string; agent?: string; model?: LegacyModel },
    output: { parts: Array<{ type: string; text: string }> },
  ) => Promise<void> | void
  "chat.params"?: (
    input: { sessionID: string; agent?: string; model: LegacyModel },
    output: { options: Record<string, unknown> },
  ) => Promise<void> | void
  "experimental.chat.system.transform"?: (
    input: { sessionID: string; model?: LegacyModel },
    output: { system: string[] },
  ) => Promise<void> | void
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void> | void
  "experimental.chat.messages.transform"?: (
    input: { sessionID: string; model?: LegacyModel },
    output: { messages: LegacyMessage[] },
  ) => Promise<void> | void
  event?: (input: { event: { type: string; properties: unknown } }) => Promise<void> | void
  tool?: Record<string, LegacyToolDefinition>
  [key: string]: unknown
}

export interface LegacyPluginInput {
  client: {
    session: {
      create: (input: { body?: { title?: string } }) => Promise<{ data?: { id: string } }>
      delete: (input: { path: { id: string } }) => Promise<void>
      prompt: (input: {
        path: { id: string }
        body?: Record<string, unknown>
      }) => Promise<{ data?: { parts?: unknown } }>
      messages: (input: { path: { id: string }; query?: Record<string, unknown> }) => Promise<unknown>
    }
    /** v1 had this under `client.postSessionByIdPermissions...`; the v2 domain method is direct. */
    permission?: { reply: (input: { sessionID: string; requestID: string; decision: string }) => Promise<void> }
  }
  app: { name: string; version: string }
  directory: string
  worktree: string
}

export type LegacyPlugin = (input: LegacyPluginInput) => Promise<LegacyHooks>

/** v2 tool name → the v1 literal the guard cores and hook bodies match. */
const V2_TO_V1_TOOL: Record<string, string> = { shell: "bash", patch: "apply_patch" }

/** The v1 tool literal a guard sees for a v2 tool call. */
export const legacyToolName = (tool: string): string => V2_TO_V1_TOOL[tool] ?? tool

/** v1 args view: write/edit expose `filePath` where v2 sends `path`. */
const legacyArgs = (tool: string, args: unknown): unknown => {
  if (!args || typeof args !== "object") return args
  if (tool !== "write" && tool !== "edit") return args
  const record = args as Record<string, unknown>
  if (typeof record.filePath === "string" || typeof record.path !== "string") return record
  return { ...record, filePath: record.path }
}

/** v1 tool results were text; a v2 result may nest its text in `output.output`. */
const readOutputText = (result: Record<string, unknown>): string => {
  if (typeof result.output === "string") return result.output
  const nested = recordOf(result.output)?.output
  if (typeof nested === "string") return nested
  return typeof result.content === "string" ? result.content : ""
}

const writeOutputText = (result: Record<string, unknown>, text: string): void => {
  if (typeof result.output === "string") {
    result.output = text
    return
  }
  const nested = recordOf(result.output)
  if (nested && typeof nested.output === "string") nested.output = text
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined

/**
 * The v1 `PluginInput.client` surface the ported guards read: the last
 * session messages in the v1 `{ data: [{ info: { role }, parts }] }` shape.
 * Retrieved from the v2 transcript (`ctx.session.context`) and translated;
 * a failed read yields an empty transcript, which the guards already treat as
 * "no assistant text" (fail-open).
 */
export const legacyClient = (ctx: any): LegacyPluginInput["client"] => ({
  session: {
    // v2 has no plugin-visible helper-session lifecycle: `create` reports no
    // session so callers bail out instead of crashing, and `delete` is a
    // no-op. Ported plugins that summarized through a helper session fall back
    // to their offline path (context-gate: extractive summarizer).
    create: async (_input: { body?: { title?: string } }) => ({ data: undefined as { id: string } | undefined }),
    delete: async (_input: { path: { id: string } }) => {},
    prompt: async (_input: { path: { id: string }; body?: Record<string, unknown> }) => ({ data: undefined }),
    messages: async ({ path }) => {
      try {
        const messages = (await ctx.session.context({ sessionID: path.id })) as ReadonlyArray<
          Record<string, unknown>
        >
        return {
          data: messages.map((message) => ({
            info: { role: message.type },
            parts: message.content ?? message.parts ?? [],
          })),
        }
      } catch {
        return { data: [] }
      }
    },
  },
  permission: {
    reply: async (input) => {
      await ctx.permission.reply({
        sessionID: input.sessionID,
        requestID: input.requestID,
        decision: input.decision,
      })
    },
  },
})

export const legacyInput = (ctx: any): LegacyPluginInput => {
  const app = recordOf(ctx.app) ?? {}
  return {
    client: legacyClient(ctx),
    app: {
      name: typeof app.name === "string" ? app.name : "opencode",
      version: typeof app.version === "string" ? app.version : "0",
    },
    directory: ctx.location.directory,
    worktree: ctx.location.directory,
  }
}

const UNSUPPORTED = new Set([
  "permission.ask",
  "shell.env",
  "auth",
  "experimental",
])

const TRANSLATED = new Set([
  "chat.message",
  "chat.params",
  "experimental.chat.system.transform",
  "experimental.chat.messages.transform",
  "experimental.session.compacting",
])

export const warnUnsupported = (hooks: LegacyHooks): void => {
  for (const key of Object.keys(hooks)) {
    if (hooks[key] === undefined) continue
    if (key === "tool" || key === "event" || key.startsWith("tool.execute.")) continue
    if (TRANSLATED.has(key)) continue
    if (UNSUPPORTED.has(key) || key.startsWith("experimental."))
      // TODO(port): this v1 hook has no v2 equivalent; the behavior is absent.
      console.warn(`[legacy-hooks-adapter] no v2 equivalent for legacy hook "${key}" — skipped`)
    else console.warn(`[legacy-hooks-adapter] unknown legacy hook "${key}" — skipped`)
  }
}

interface StandardField {
  readonly validate: (value: unknown) => unknown
  readonly jsonSchema?: { readonly input: (options: unknown) => unknown }
}

const JSON_SCHEMA_TARGET = { target: "draft-2020-12" }

const standardField = (field: unknown): StandardField | undefined => {
  const standard = recordOf(recordOf(field)?.["~standard"])
  return standard && typeof standard.validate === "function" ? (standard as unknown as StandardField) : undefined
}

const issuesOf = (result: unknown): ReadonlyArray<unknown> | undefined => {
  const record = recordOf(result)
  return record && Array.isArray(record.issues) ? record.issues : undefined
}

/**
 * A v1 `args` record as one StandardSchemaV1 object: per-field validation runs
 * through each field's own `~standard.validate`, so the plugin's zod copy stays
 * authoritative. A field is required when validating `undefined` reports issues.
 */
const legacyObjectSchema = async (fields: Record<string, unknown>) => {
  const required: string[] = []
  const properties: Record<string, unknown> = {}
  const probes = new Map<string, StandardField>()

  for (const [name, field] of Object.entries(fields)) {
    const standard = standardField(field)
    if (!standard) continue
    probes.set(name, standard)
    const record = recordOf(standard.jsonSchema?.input(JSON_SCHEMA_TARGET))
    if (record) {
      const { $schema: _schema, ...rest } = record
      properties[name] = rest
    }
    if (issuesOf(await standard.validate(undefined))) required.push(name)
  }

  return {
    "~standard": {
      version: 1,
      vendor: "legacy-hooks-adapter",
      jsonSchema: {
        input: () => ({
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        }),
        output: () => ({}),
      },
      validate: async (value: unknown) => {
        const input = recordOf(value) ?? {}
        const decoded: Record<string, unknown> = {}
        const issues: Array<{ message: string; path: Array<string> }> = []
        for (const [name, standard] of probes) {
          if (!(name in input)) continue
          const result = await standard.validate(input[name])
          const fieldIssues = issuesOf(result)
          if (fieldIssues)
            issues.push(
              ...fieldIssues.map((issue) => ({ message: String(recordOf(issue)?.message ?? "invalid"), path: [name] })),
            )
          else decoded[name] = recordOf(result)?.value
        }
        return issues.length ? { issues } : { value: decoded }
      },
    },
  }
}

/** Legacy custom tools → v2 tool registrations. */
const registerTools = async (ctx: any, tools: LegacyHooks["tool"]): Promise<Array<{ dispose: () => Promise<void> }>> => {
  if (!tools) return []
  const entries = Object.entries(tools)
  if (entries.length === 0) return []
  const schemas = await Promise.all(
    entries.map(async ([name, definition]) => {
      return [name, definition, await legacyObjectSchema(definition.args ?? {})] as const
    }),
  )
  const registration = await ctx.tool.transform((editor: any) => {
    for (const [name, definition, input] of schemas) {
      editor.add({
        name,
        description: definition.description ?? "",
        input,
        execute: async (args: unknown, context: any) => {
          const value = await definition.execute(args as never, {
            ...context,
            directory: ctx.location.directory,
            abort: context.signal,
          })
          return normalizeToolResult(value)
        },
      })
    }
  })
  return [registration]
}

/** v1 execute returns text or `{ title, output, metadata }`; v2 wants `Result`. */
const normalizeToolResult = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") return { content: value }
  const record = recordOf(value)
  if (!record) return { content: String(value) }
  const text = record.output ?? record.content
  return {
    ...(text === undefined ? { content: "" } : { content: text }),
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
  }
}

/** v1 `PluginInput.client` shim + message-model translation helpers. */
const legacyModel = (model: unknown): LegacyModel | undefined => {
  const record = recordOf(model)
  if (!record) return undefined
  const id = typeof record.id === "string" ? record.id : typeof record.modelID === "string" ? record.modelID : undefined
  return {
    ...(typeof record.providerID === "string" ? { providerID: record.providerID } : {}),
    ...(id === undefined ? {} : { id, modelID: id }),
    capabilities: recordOf(record.capabilities) ?? {},
  }
}

/**
 * One AI-SDK content block as the v1 part the plugins were written against.
 * Tool blocks become v1 `tool` parts (so a `jev_*` usage scan still works), and
 * a media block becomes a v1 `file` part carrying its data URL or remote URL.
 */
const legacyPart = (part: Record<string, unknown>): Record<string, unknown> => {
  const type = part.type
  if (type === "text") return { type: "text", text: part.text }
  if (type === "reasoning") return { type: "reasoning", text: part.text }
  if (type === "tool-call")
    return { type: "tool", tool: part.name, callID: part.id, state: { status: "running", input: part.input } }
  if (type === "tool-result")
    return { type: "tool", tool: part.name, callID: part.id, state: { status: "completed" }, output: part.result }
  if (type === "media") {
    const asset = recordOf(part.media)
    const source = recordOf(asset?.source)
    const inline =
      typeof asset?.inline === "function" ? recordOf((asset.inline as () => unknown)()) : recordOf(asset?.inline)
    const mime = typeof asset?.mediaType === "string" ? asset.mediaType : undefined
    const url =
      typeof inline?.dataUrl === "string"
        ? inline.dataUrl
        : typeof source?.url === "string"
          ? source.url
          : typeof source?.data === "string" && source.type === "base64"
            ? `data:${mime ?? "application/octet-stream"};base64,${source.data}`
            : undefined
    return { type: "file", mime, ...(url === undefined ? {} : { url }) }
  }
  return { type: typeof type === "string" ? type : "unknown" }
}

/** The v1 message view a `experimental.chat.messages.transform` legacy hook mutates. */
const legacyMessages = (messages: ReadonlyArray<unknown>, sessionID: string, providerID?: string): LegacyMessage[] =>
  messages.map((message) => {
    const record = recordOf(message) ?? {}
    const role = typeof record.role === "string" ? record.role : undefined
    const content = Array.isArray(record.content) ? record.content : []
    return {
      info: { ...(role === undefined ? {} : { role }), sessionID, ...(providerID === undefined ? {} : { providerID }) },
      ...(role === undefined ? {} : { role }),
      parts: content.map((part) => legacyPart(recordOf(part) ?? {})),
    }
  })

/**
 * Writes the legacy hook's mutations back onto the AI-SDK messages, in place on
 * the transient request array. A replaced part (v1 `parts[i]` is text where the
 * content block was not, e.g. the image bridge) replaces that block; parts
 * appended past the original length become trailing text blocks. A replaced
 * message slot keeps the original prototype so it stays a real `Message`.
 */
const applyLegacyMessages = (messages: Array<unknown>, view: LegacyMessage[]): void => {
  messages.forEach((message, index) => {
    const record = recordOf(message)
    const next = view[index]
    if (!record || !next) return
    const content = Array.isArray(record.content) ? record.content : []
    let changed = false
    const blocks = content.map((block, partIndex) => {
      const legacy = next.parts[partIndex]
      if (!legacy || typeof legacy.text !== "string") return block
      if (legacy.type !== "text") return block
      const current = recordOf(block)
      if (current?.type === "text" && current.text === legacy.text) return block
      changed = true
      return current?.type === "text" ? { ...current, text: legacy.text } : { type: "text", text: legacy.text }
    })
    const appended = next.parts.slice(content.length).flatMap((part) =>
      part.type === "text" && typeof part.text === "string"
        ? [{ type: "text", text: part.text, metadata: { synthetic: true } }]
        : [],
    )
    if (!changed && appended.length === 0) return
    messages[index] = Object.assign(Object.create(Object.getPrototypeOf(record)), {
      ...record,
      content: [...blocks, ...appended],
    })
  })
}

/** The system part v1 `system[0]` addressed: the rendered instruction block. */
const instructionsPart = (system: ReadonlyArray<unknown> | undefined): { text: string } | undefined => {
  if (!Array.isArray(system)) return undefined
  const parts = system.filter((part): part is { text: string; metadata?: Record<string, unknown> } => {
    const record = recordOf(part)
    return record !== undefined && typeof record.text === "string"
  })
  const instructions = parts.find((part) => recordOf(recordOf(part.metadata)?.experimental)?.instructions !== undefined)
  return (instructions ?? parts[parts.length - 1]) as { text: string } | undefined
}

/**
 * Registers a legacy hooks object against the v2 ctx. Returns the registrations
 * to dispose; a `tool.execute.before` throw still escapes, which the v2 tool
 * runtime turns into a rejected call (packages/plugin/src/promise/adapter.ts).
 */
export const adaptLegacyHooks = async (hooks: LegacyHooks, ctx: any) => {
  warnUnsupported(hooks)
  const registrations: Array<{ dispose: () => Promise<void> }> = []
  const before = hooks["tool.execute.before"]
  const after = hooks["tool.execute.after"]

  if (before)
    registrations.push(
      await ctx.tool.hook("execute.before", async (event: any) => {
        await before(
          { tool: legacyToolName(event.tool), sessionID: event.sessionID, callID: event.id, agent: event.agent },
          { args: legacyArgs(event.tool, event.input) },
        )
      }),
    )

  if (after)
    registrations.push(
      await ctx.tool.hook("execute.after", async (event: any) => {
        // baseline-guard:dump adapter authored this session (new file, no prior artifact); validated by the live plugin reload
        const completed = event.status === "completed"
        const result = completed ? recordOf(event.result) ?? {} : {}
        const output: LegacyToolHookOutput = {
          args: legacyArgs(event.tool, event.input),
          output: completed ? readOutputText(result) : "",
          metadata: completed ? (result.metadata as Record<string, unknown> | undefined) : undefined,
        }
        try {
          await after(
            { tool: legacyToolName(event.tool), sessionID: event.sessionID, callID: event.id, agent: event.agent },
            output,
          )
        } catch (error) {
          // The v1 after-hook was an advisory channel here (no ported plugin
          // blocks from it); a throw must not fail an already-run call.
          console.warn("[legacy-hooks-adapter] tool.execute.after failed", error)
          return
        }
        if (!completed) return
        // Write mutations back: the v2 after event's `result` is the live object
        // the runtime returns, so an appended advisory reaches the model.
        if (typeof output.output === "string") writeOutputText(result, output.output)
        if (output.metadata !== undefined) result.metadata = output.metadata
      }),
    )

  registrations.push(...(await registerTools(ctx, hooks.tool)))

  // Per-session model, captured from the v2 request seam so a later
  // `chat.message` / transform sees the same model the request will use.
  const sessionModel = new Map<string, LegacyModel>()

  // v1 `chat.params` and `experimental.chat.system.transform` both mutate the
  // request the model will receive, so they run on the v2 request seam that
  // carries mutable `options` and `system`: the session `context` hook. The
  // `model.request` event has neither, so mapping them there would drop every
  // write (a silent no-op for effort routing and system-prompt gating).
  const chatParams = hooks["chat.params"]
  const systemTransform = hooks["experimental.chat.system.transform"]
  if (chatParams || systemTransform)
    registrations.push(
      await ctx.session.hook("context", async (event: any) => {
        const model = legacyModel(event.model)
        if (model && typeof event.sessionID === "string") sessionModel.set(event.sessionID, model)
        // v1 always handed a model; without one there is nothing for an effort
        // router to match against, so the hook is skipped rather than guessed.
        if (chatParams && model) {
          const output = { options: event.options ?? {} }
          await chatParams({ sessionID: event.sessionID, agent: event.agent, model }, output)
          // v1 plugins rebuild the record (`output.options = { ... }`), so the
          // reassignment has to travel back onto the draft the request uses.
          if (output.options !== event.options) event.options = output.options
        }
        if (systemTransform) {
          // v1 exposed the instructions block as `system[0]`; v2 keeps it as the
          // `SystemPart` carrying the rendered instruction metadata, so the
          // legacy view indexes that part and writes text back into it. Extra
          // entries a v1 plugin pushes become trailing text parts.
          const target = instructionsPart(event.system)
          const view = { system: [target?.text ?? ""] }
          await systemTransform({ sessionID: event.sessionID, model }, view)
          if (target && typeof view.system[0] === "string") target.text = view.system[0]
          for (const extra of view.system.slice(1))
            if (typeof extra === "string" && extra.length > 0) event.system.push({ type: "text", text: extra })
        }
      }),
    )

  // v1 `experimental.session.compacting` handed the summarizer extra context
  // through an output `context: string[]`. v2 has no such sink, so the same
  // strings ride the compaction request as trailing system parts.
  const compacting = hooks["experimental.session.compacting"]
  if (compacting)
    registrations.push(
      await ctx.session.hook("compaction", async (event: any) => {
        const output: { context: string[]; prompt?: string } = { context: [] }
        await compacting({ sessionID: event.sessionID }, output)
        for (const text of output.context)
          if (typeof text === "string" && text.length > 0) event.system.push({ type: "text", text })
      }),
    )

  const chatMessage = hooks["chat.message"]
  if (chatMessage)
    registrations.push(
      await ctx.session.hook("prompt", async (event: any) => {
        const text = typeof event.prompt?.text === "string" ? event.prompt.text : ""
        try {
          await chatMessage(
            { sessionID: event.sessionID, model: sessionModel.get(event.sessionID) },
            { parts: [{ type: "text", text }] },
          )
        } catch (error) {
          // A legacy `chat.message` was advisory: it must not fail the prompt.
          console.warn("[legacy-hooks-adapter] chat.message failed", error)
        }
      }),
    )

  const messagesTransform = hooks["experimental.chat.messages.transform"]
  if (messagesTransform)
    registrations.push(
      await ctx.session.hook("context", async (event: any) => {
        const model = legacyModel(event.model) ?? sessionModel.get(event.sessionID)
        if (model && typeof event.sessionID === "string") sessionModel.set(event.sessionID, model)
        const messages = Array.isArray(event.messages) ? event.messages : []
        const view = legacyMessages(messages, String(event.sessionID ?? ""), model?.providerID)
        try {
          await messagesTransform({ sessionID: String(event.sessionID ?? ""), model }, { messages: view })
        } catch (error) {
          // The v1 transform hooks are advisory (tail appends). A throw fails the
          // model request in v2, so it degrades to a warning instead.
          console.warn("[legacy-hooks-adapter] experimental.chat.messages.transform failed", error)
          return
        }
        applyLegacyMessages(messages, view)
      }),
    )

  const controller = new AbortController()
  const onEvent = hooks.event
  if (onEvent)
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await onEvent({ event: { type: event.type, properties: event.data } })
          } catch {
            // fail-open: one bad handler never stops the subscription
          }
        }
      } catch {
        // fail-open: a closed subscription is not a plugin failure
      }
    })()

  return {
    dispose: async () => {
      controller.abort()
      sessionModel.clear()
      for (const registration of registrations) await registration.dispose()
    },
  }
}

/** `export default defineLegacyPlugin(id, factory)` — the v2 module contract. */
export const defineLegacyPlugin = (id: string, factory: LegacyPlugin) => ({
  id,
  setup: async (ctx: any) => {
    const adapter = await adaptLegacyHooks(await factory(legacyInput(ctx)), ctx)
    return () => adapter.dispose()
  },
})
