import { LayerNode } from "@opencode/core/effect/layer-node"
import { httpClient } from "@opencode/core/effect/app-node-platform"
import path from "path"
import { createHash } from "node:crypto"
import { SessionV1 } from "@opencode/schema/v1/session"
import { WithParts } from "@/compat/schema/session-v1"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@/flag/flag"
import { FSUtil } from "@opencode/util/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@opencode/util/global"
import type { MessageV2 } from "./message-v2"
import type { MessageID, PartID } from "./schema"

function extract(messages: WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

const BLOCK_OPEN = "<project-instructions>"
const BLOCK_CLOSE = "</project-instructions>"
// Durable fingerprint of the persisted block. Presence AND freshness both read
// from projected history, so a restart — which empties any process-local cache —
// neither re-attaches a duplicate nor misses a refresh.
export const BLOCK_META = "instructionBlock"

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly staticBlock: (input: {
    messages: WithParts[]
  }) => Effect.Effect<{ text: string; hash: string; replace: PartID | undefined } | undefined, FSUtil.Error>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
          // Memoized nested AGENTS.md discovery: paths only, no content. The
          // glob over a large tree is not free and system() runs per loop step.
          nestedGuides: undefined as string[] | undefined,
        }),
      ),
    )

    // Nested AGENTS.md guides below the instance root, discovered once per
    // instance. Their CONTENT is never loaded eagerly; system() surfaces only
    // this path index and resolve() attaches the guide when a session reads
    // or runs commands inside the subtree.
    const nestedGuides = Effect.fn("Instruction.nestedGuides")(function* () {
      const s = yield* InstanceState.get(state)
      if (s.nestedGuides) return s.nestedGuides
      const ctx = yield* InstanceState.context
      const found = yield* fs
        .glob("**/AGENTS.md", { cwd: ctx.directory, absolute: true, include: "file", dot: true })
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      s.nestedGuides = found
        .map((item) => path.resolve(item))
        .filter((resolved) => !resolved.includes(`${path.sep}node_modules${path.sep}`))
        // Glob order is FS-dependent; index rides the wire so sort for byte stability.
        .toSorted()
      return s.nestedGuides
    })

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      const content = yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (content === undefined) {
        yield* Effect.logWarning("instruction file unreadable", { path: filepath })
        return ""
      }
      return content
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
        // Nested package guides are deliberately NOT loaded here. Their full
        // text is only attached on demand by resolve() when a session reads a
        // file or runs a command inside their subtree; system() surfaces a
        // compact path index so the model still knows they exist.
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      // The root-level guide already rides in paths (glob "**/AGENTS.md" also
      // matches at the root); the index only covers guides not yet loaded.
      const nested = (yield* nestedGuides()).filter((item) => !paths.has(item))
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      // Sort: Set insertion order follows FS glob/findUp discovery order,
      // which is nondeterministic; the wire body must be byte-stable.
      const ordered = Array.from(paths).toSorted()
      const files = yield* Effect.forEach(ordered, read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      // Compact index of package-level guides whose full text is NOT loaded.
      // Names the guide so the model knows it exists and can read it via its
      // file tools when it starts working in that subtree (read/shell also
      // auto-attach it there).
      const nestedIndex: string[] =
        nested.length > 0
          ? [
              `Package-level AGENTS.md guides exist but are not preloaded: ${nested.join(", ")}`,
              "The matching guide is attached automatically when you read files or run commands in that subtree; or read it directly when you need its rules early.",
            ]
          : []

      const loaded = [
        ...(paths.size + urls.length > 0 || nestedIndex.length > 0
          ? [
              // Precedence preamble: makes conflict resolution explicit when
              // global, project, and package-level guides disagree. Global
              // rules are inherited by every project and outrank local rules.
              [
                "The following instruction files apply to this project.",
                "Every project inherits the global rules; project-level rules extend them.",
                "They are listed global-first: global, then project root, then package-level guides.",
                "On conflict, the global rules ALWAYS take precedence over project-level rules.",
              ].join("\n"),
            ]
          : []),
        ...ordered.flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
        ...(nestedIndex.length > 0 ? [nestedIndex.join("\n")] : []),
      ]

      // Loading summary so gaps are visible: a skipped or unreadable rule file
      // would otherwise silently shrink the instruction surface.
      const bytes = files.reduce((sum, file) => sum + file.length, 0)
      yield* Effect.logInfo("instruction files loaded", {
        count: loaded.length,
        discovered: paths.size + urls.length,
        files: ordered.length,
        urls: urls.length,
        nestedIndexed: nested.length,
        bytes,
        paths: ordered,
      })

      return loaded
    })

    // The static block is ~8k tokens and is byte-identical across requests, so
    // re-attaching it at the tail every LLM call re-bills it uncached. Persist
    // it once instead. The durable hash on the persisted part is the ONLY source
    // of presence and freshness: process-local state would be empty after a
    // restart and would re-attach a duplicate. `replace` points at the prior
    // part so an edit updates it in place — the invariant is at most one block
    // part in history, so no stale contradictory copy can accumulate.
    const staticBlock = Effect.fn("Instruction.staticBlock")(function* (input: {
      messages: WithParts[]
    }) {
      const prior = input.messages
        .flatMap((msg) => msg.parts)
        .find(
          (part): part is SessionV1.TextPart =>
            part.type === "text" && typeof part.metadata?.[BLOCK_META] === "string",
        )
      const blocks = yield* system()
      if (blocks.length === 0) return undefined
      const text = [BLOCK_OPEN, ...blocks, BLOCK_CLOSE].join("\n")
      const hash = createHash("sha256").update(text).digest("hex")
      // Absent part (post-compaction or never attached) attaches fresh; a
      // matching durable hash suppresses; a stale one refreshes in place.
      if (prior?.metadata?.[BLOCK_META] === hash) return undefined
      return { text, hash, replace: prior?.id }
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      // In-project paths stop at the instance root; external paths walk to the
      // filesystem root (bounded, so we never scan above the drive).
      while (current !== root && current !== path.dirname(current)) {
        if (current.startsWith(root) && current === root) break
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, staticBlock, systemPaths, system, find, resolve })
  }),
)

export function loaded(messages: WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient],
})

export * as Instruction from "./instruction"
