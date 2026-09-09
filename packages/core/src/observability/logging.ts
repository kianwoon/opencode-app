import { Formatter, Logger, type LogLevel } from "effect"
import fs from "node:fs"
import path from "path"
import { Global } from "../global"
import { runID } from "./shared"

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

// Log rotation: opencode.log grows unbounded across restarts (202MB over one
// month on the dev machine), slowing every log search and risking disk. Rotate
// once per process at logger creation when the file exceeds the threshold, and
// prune the oldest rotations. In-run growth is bounded by process lifetime;
// long-lived processes re-rotate on their next boot.
const rotateBytes = 50 * 1024 * 1024
const rotateKeep = 5
let rotated = false

function rotateLog(file: string) {
  if (rotated) return
  rotated = true
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < rotateBytes) return
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const rotatedFile = file.replace(/\.log$/, `-${stamp}.log`)
    fs.renameSync(file, rotatedFile)
    const prefix = path.basename(file, ".log")
    const rotations = fs
      .readdirSync(path.dirname(file))
      .filter((item) => item.startsWith(`${prefix}-`) && item.endsWith(".log"))
      .sort()
    for (const item of rotations.slice(0, Math.max(0, rotations.length - rotateKeep))) {
      fs.unlinkSync(path.join(path.dirname(file), item))
    }
  } catch {
    // Rotation is best-effort; never block the logging pipeline on it.
  }
}

export function fileLogger(file = path.join(Global.Path.log, "opencode.log"), id: string = runID) {
  rotateLog(file)
  // Do not set batchWindow to 0; it causes high idle CPU usage.
  return Logger.toFile(formatter(id), file, { flag: "a" })
}

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.OPENCODE_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.OPENCODE_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

export * as Logging from "./logging"
