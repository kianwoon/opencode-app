import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import { createHash } from "node:crypto"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { evaluate } from "@/permission/evaluate"
import { Config } from "@/config/config"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const RETENTION = Duration.days(7)

// Process-wide hash-dedup state: (sessionID, toolName) -> hash of the last full
// output written for that key, plus hash -> file path so identical outputs reuse
// the existing file instead of duplicating 60KB+ dumps.
const lastOutputHash = new Map<string, string>()
const hashToFile = new Map<string, string>()

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
  /** Dedup key (usually `${sessionID}/${toolName}`): identical consecutive outputs reuse the previous file. */
  dedupKey?: string
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
  /**
   * Records the hash of a full tool output for `dedupKey`. Call before `output` so an identical
   * consecutive output reuses the previously written file instead of duplicating 60KB+ dumps.
   */
  readonly dedup: (key: string, text: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        const file = path.join(TRUNCATION_DIR, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const mtime = info && Option.getOrUndefined(info.mtime)
        if (!mtime || mtime.getTime() >= cutoff) continue
        yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "head"
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      const out: string[] = []
      let i = 0
      let bytes = 0
      let hitBytes = false

      if (direction === "head") {
        for (i = 0; i < lines.length && i < maxLines; i++) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.push(lines[i])
          bytes += size
        }
      } else {
        for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.unshift(lines[i])
          bytes += size
        }
      }

      const removedLines = lines.length - out.length
      const removedBytes = totalBytes - bytes
      const unit = hitBytes ? "bytes" : "lines"
      const removed = hitBytes ? removedBytes : removedLines
      const preview = out.join("\n")

      // Hash-dedup: when this exact output was already written for this key, reuse
      // that file instead of duplicating another 60KB+ dump on disk.
      const hash = createHash("sha256").update(text).digest("hex")
      if (options.dedupKey) {
        const previous = lastOutputHash.get(options.dedupKey)
        lastOutputHash.set(options.dedupKey, hash)
        if (previous && previous === hash) {
          const existing = hashToFile.get(previous)
          if (existing && (yield* fs.stat(existing).pipe(Effect.catch(() => Effect.succeed(undefined))))) {
            const dedupHint = hasTaskTool(agent)
              ? `Identical to the previous tool output. Full output already saved to: ${existing}\nDelegate to the Task tool (explore agent) to process it - do NOT read the full file yourself and do NOT repeat this call.`
              : `Identical to the previous tool output. Full output already saved to: ${existing}\nUse Grep on that file or Read with offset/limit for specific sections - do NOT repeat this call.`
            const marker = `... [truncated ${removedBytes} bytes (${removedLines} lines), identical duplicate — full output in ${existing}] ...`
            return {
              content: direction === "head" ? `${preview}\n\n${marker}\n\n${dedupHint}` : `${marker}\n\n${dedupHint}\n\n${preview}`,
              truncated: true,
              outputPath: existing,
            } as const
          }
        }
      }

      const file = yield* write(text)
      hashToFile.set(hash, file)

      const hint = hasTaskTool(agent)
        ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
        : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

      // Explicit marker always carries byte count + file path so a mid-line byte cut
      // (e.g. inside JSON) is never mistaken for complete output.
      const marker = `... [truncated ${removedBytes} bytes (${removedLines} lines omitted), full output in ${file}] ...`

      return {
        content: direction === "head" ? `${preview}\n\n${marker}\n\n${hint}` : `${marker}\n\n${hint}\n\n${preview}`,
        truncated: true,
        outputPath: file,
      } as const
    })

    const dedup = Effect.fn("Truncate.dedup")(function* (key: string, text: string) {
      lastOutputHash.set(key, createHash("sha256").update(text).digest("hex"))
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits, dedup })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Truncate from "./truncate"
