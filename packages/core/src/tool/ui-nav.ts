import { spawnSync } from "child_process"
import { homedir } from "os"
import path from "path"
import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"

/**
 * THIN TOOL over the ONE validated GUI sensor: the `axnav` CLI.
 *
 * This tool owns no perception of its own. It builds an explicit argv (never a
 * shell string), runs the sensor, and returns the sensor's own JSON verdict line
 * verbatim plus a one-line human summary. A non-zero exit, an empty stdout, or
 * non-JSON output is returned as a typed passthrough naming what came back — it
 * never fabricates a success and never returns a silent empty result.
 */

const AXNAV = path.join(homedir(), ".config", "opencode", "bin", "agent-toolkit", "axnav")

const VERBS = ["windows", "map", "find", "sel", "press"]
type Verb = (typeof VERBS)[number]

// This Effect build's `Schema.Literal` accepts a single value, so a closed set
// of strings is a Union of single-value literals.
const enumeration = <Values extends string[]>(...values: Values) =>
  Schema.Union(values.map((value) => Schema.Literal(value)))

export const Parameters = Schema.Struct({
  verb: enumeration(...VERBS).annotate({
    description: "Sensor verb: windows|map (read-only enumeration), find|sel (read-only lookup), press (AXPress + read-back).",
  }),
  app: Schema.String.annotate({ description: "Target application name, e.g. \"System Settings\"." }),
  label: Schema.optional(Schema.String).annotate({
    description: "Accessible-name label to locate. Required for find|sel|press.",
  }),
  index: Schema.optional(Schema.Int).annotate({
    description: "Match index (press only) — explicit escape hatch when a label resolves to several distinct targets.",
  }),
  window: Schema.optional(Schema.String).annotate({
    description: "Scope resolution to a window by title or AXIdentifier (--window). Omitted: the focused window.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = {}

const LABELLED: Verb[] = ["find", "sel", "press"]

/** The exact argv handed to the sensor — explicit positions, no shell string. */
export function buildArgs(params: Params): string[] {
  const args = [params.verb, params.app]
  if (params.label !== undefined) args.push(params.label)
  if (params.verb === "press" && params.index !== undefined) args.push(String(params.index))
  if (params.window !== undefined) args.push("--window", params.window)
  return args
}

function error(kind: string, detail: string, raw: string): { title: string; output: string; metadata: Metadata } {
  return {
    title: `ui_nav: error (${kind})`,
    output: JSON.stringify({ effect: "error", kind, detail, raw }),
    metadata: {},
  }
}

function summarize(verdict: unknown): string {
  const v = verdict as Record<string, unknown>
  const parts = [
    typeof v.effect === "string" ? v.effect : "ok",
    typeof v.app === "string" ? v.app : undefined,
    typeof v.label === "string" ? `"${v.label}"` : undefined,
    Array.isArray(v.windows) ? `${v.windows.length} window(s)` : undefined,
    Array.isArray(v.rows) ? `${v.rows.length} row(s)` : undefined,
    typeof v.reason === "string" ? `— ${v.reason}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.join(" ")
}

/** Pass the sensor's verdict through verbatim; a bad exit/output becomes a typed error. */
export function verdictFromRun(
  status: number | null,
  stdout: string,
  stderr: string,
): { title: string; output: string; metadata: Metadata } {
  const line = stdout.trim()
  if (status !== 0) return error("nonzero_exit", `exit ${status}`, line || stderr.trim())
  if (!line) return error("empty_stdout", "empty stdout", stderr.trim())
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(line)
  if (Option.isNone(parsed)) return error("non_json", "stdout is not JSON", line)
  const effect = (parsed.value as { effect?: unknown }).effect
  return {
    title: `ui_nav: ${typeof effect === "string" ? effect : "ok"}`,
    output: `${line}\n${summarize(parsed.value)}`,
    metadata: {},
  }
}

export const UiNavTool = Tool.define<typeof Parameters, Metadata, never>(
  "ui_nav",
  Effect.gen(function* () {
    return {
      description:
        "Invoke the validated `axnav` GUI sensor and return its typed verdict (`effect` in {confirmed, refused, suspected_noop, unverifiable} plus `provenance`/`walk`). Verbs: `windows`/`map` (read-only enumeration), `find`/`sel` (read-only lookup), `press` (AXPress then read-back, judged by destination change). Parameters mirror the CLI: verb, app, optional label, optional index (press), optional window scope. The sensor refuses rather than guessing; a non-zero exit, empty stdout, or non-JSON output is returned as a typed error passthrough, never a fabricated success.",
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          if (LABELLED.includes(params.verb) && params.label === undefined) {
            return error("missing_label", `verb ${params.verb} requires a label`, "")
          }
          const args = buildArgs(params)
          const proc = yield* Effect.sync(() => spawnSync(AXNAV, args, { encoding: "utf8" }))
          return verdictFromRun(proc.status, proc.stdout ?? "", proc.stderr ?? "")
        }),
    }
  }),
)
