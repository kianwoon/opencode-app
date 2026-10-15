#!/usr/bin/env bun
/**
 * ui-smoke — exercise the REAL ui_run plan loop against a live window, with no
 * desktop rebuild, no packaging and no app restart.
 *
 * This harness imports the shipped tool (`src/tool/ui-run.ts` → `UiRunTool`) and
 * invokes its own `execute` through the SAME app runtime and service graph the
 * CLI uses (`AppRuntime` + `InstanceStore.Service.provide`). It does NOT
 * re-implement, copy or stub the loop's decision logic: a green result is the
 * product path working, never a parallel test double. The cua-driver MCP server
 * is spawned over stdio from the user's opencode config (`config.mcp`, the same
 * binary the app configures), falling back to `cua-driver` on PATH; the jev key
 * resolves exactly as `src/jev/controller.ts` does (auth.json, then env).
 *
 * Run (from packages/opencode):
 *   bun run script/ui-smoke.ts --goal "<goal>"
 *   bun run script/ui-smoke.ts --goal "<goal>" --pid <n> --window <n>
 *   bun run script/ui-smoke.ts --goal "<goal>" --tree-format elements --max-steps 1
 *   bun run script/ui-smoke.ts --help
 *
 * When `--pid`/`--window` are omitted the frontmost on-screen window on the
 * current Space is picked (a browser-like app wins) and printed. `--tree-format`
 * selects the tree format of the harness's pre-flight observation only; the loop
 * owns its own observation payload.
 *
 * Exit codes: 0 ONLY when the loop reports a genuine `completed`. A missing
 * connection, a missing window, a driver/jev error or an unparseable response
 * exits non-zero with the raw error text; a canned or inferred success is never
 * printed.
 */
import { Cause, Effect } from "effect"
import { parseArgs } from "node:util"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { MessageID, SessionID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { UiRunTool } from "@/tool/ui-run"

/** The MCP server name the app configures for the computer-use channel. */
const DRIVER_SERVER = "cua-driver"
/** The PATH command used only when the user's config carries no driver server. */
const DRIVER_FALLBACK_COMMAND = [DRIVER_SERVER, "mcp"] as const
const DRIVER_TOOL_PREFIX = `${DRIVER_SERVER}_`

const USAGE = `ui-smoke — run the real ui_run loop against a live window (no desktop rebuild)

Usage: bun run script/ui-smoke.ts --goal "<goal>" [options]

Options:
  --goal <text>        Goal the loop drives to (required).
  --pid <n>            Target window pid (as reported by list_windows).
  --window <n>         Target window_id (as reported by list_windows).
  --tree-format <fmt>  Tree format for the pre-flight observation (default: elements).
  --max-steps <n>      Max observe→decide→act→verify iterations (default: the tool's own).
  -h, --help           Show this help.

When --pid/--window are omitted the frontmost on-screen window is picked and printed.
Exit code is 0 only when the loop reports "completed"; any error exits non-zero.
`

type Args = {
  goal?: string
  pid?: number
  window?: number
  treeFormat: string
  maxSteps?: number
  help?: boolean
}

function parseCli(argv: readonly string[]): Args {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      goal: { type: "string" },
      pid: { type: "string" },
      window: { type: "string" },
      "tree-format": { type: "string" },
      "max-steps": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  })
  const int = (raw: string | undefined, flag: string): number | undefined => {
    if (raw === undefined) return undefined
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) throw new Error(`${flag} must be an integer (got "${raw}")`)
    return n
  }
  return {
    ...(values.goal !== undefined ? { goal: values.goal } : {}),
    ...(values.pid !== undefined ? { pid: int(values.pid, "--pid") } : {}),
    ...(values.window !== undefined ? { window: int(values.window, "--window") } : {}),
    treeFormat: values["tree-format"] ?? "elements",
    ...(values["max-steps"] !== undefined ? { maxSteps: int(values["max-steps"], "--max-steps") } : {}),
    ...(values.help === true ? { help: true } : {}),
  }
}

// --- driver MCP call plumbing (the same client the loop drives) --------------

type TextItem = { type: string; text?: string }
type DriverResult = { content?: readonly TextItem[]; structuredContent?: unknown; isError?: boolean }

const textOf = (content: readonly TextItem[] | undefined): string =>
  (content ?? []).flatMap((item) => (item.type === "text" && item.text ? [item.text] : [])).filter((t) => t.trim()).join("\n\n")

/** The tool's structured payload: structuredContent when present, else the JSON text body. */
function structuredOf(result: DriverResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = textOf(result.content)
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

type DriverOutcome = { ok: true; structured: unknown } | { ok: false; error: string }

const callDriver = (tool: MCP.McpTool, args: Record<string, unknown>): Effect.Effect<DriverOutcome> =>
  Effect.tryPromise(() =>
    tool.client.callTool({ name: tool.def.name, arguments: args }, CallToolResultSchema, {
      resetTimeoutOnProgress: true,
      timeout: tool.timeout ?? 30_000,
      onprogress: () => {},
    }),
  ).pipe(
    Effect.map((raw): DriverOutcome => {
      const result = raw as unknown as DriverResult
      if (result.isError === true) return { ok: false, error: textOf(result.content) || `${tool.def.name} returned an error` }
      return { ok: true, structured: structuredOf(result) }
    }),
    Effect.catchCause((cause): Effect.Effect<DriverOutcome> =>
      Effect.succeed({ ok: false, error: Cause.pretty(cause) }),
    ),
  )

// --- window resolution -------------------------------------------------------

interface WindowRec {
  readonly window_id: number
  readonly pid: number
  readonly app_name?: string
  readonly title?: string
  readonly z_index?: number | null
  readonly is_on_screen?: boolean | null
  readonly on_current_space?: boolean | null
}

function windowsOf(payload: unknown): WindowRec[] {
  const record = payload as { windows?: unknown } | undefined
  const list = Array.isArray(record?.windows) ? (record?.windows as unknown[]) : Array.isArray(payload) ? payload : []
  return list.filter(
    (entry): entry is WindowRec =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as WindowRec).window_id === "number" &&
      typeof (entry as WindowRec).pid === "number",
  )
}

const zIndexOf = (window: WindowRec): number => (typeof window.z_index === "number" ? window.z_index : -Infinity)

/**
 * Pick the FRONTMOST on-screen window on the current Space; a browser-like app
 * (its name carries the generic word "browser") wins so a stacked helper does not.
 * Never a named app/site — the classifier is the role word only.
 */
function pickWindow(windows: readonly WindowRec[]): WindowRec | undefined {
  const visible = windows.filter((w) => w.is_on_screen !== false && w.on_current_space !== false)
  const pool = visible.filter((w) => /browser/i.test(w.app_name ?? ""))
  const candidates = pool.length > 0 ? pool : visible
  return [...candidates].sort((a, b) => zIndexOf(b) - zIndexOf(a))[0]
}

const describeWindow = (w: WindowRec): string =>
  `pid=${w.pid} window_id=${w.window_id} app=${w.app_name ?? "?"} title=${JSON.stringify(w.title ?? "")} z_index=${w.z_index ?? "n/a"}`

// --- the run ----------------------------------------------------------------

interface StepTelemetry {
  readonly subgoalIndex: number
  readonly maneuver: string
  readonly label: string
  readonly strength?: number
  readonly deliveryModes: readonly string[]
  readonly progress: { readonly done: number; readonly total: number; readonly reasons: readonly string[] }
  readonly reason: string
}

interface RunSummary {
  readonly status: string
  readonly planId?: string
  readonly telemetry: readonly StepTelemetry[]
  readonly promotionCandidates: readonly unknown[]
  readonly evidence?: readonly string[]
  readonly consent?: unknown
}

type Outcome =
  | { readonly kind: "ran"; readonly window: WindowRec; readonly title: string; readonly output: string; readonly summary: RunSummary }
  | { readonly kind: "failed"; readonly message: string }

const run = <A, R>(effect: Effect.Effect<A, unknown, R>): Promise<A> =>
  AppRuntime.runPromise(
    InstanceStore.Service.use((store) => store.provide({ directory: AbsolutePath.make(process.cwd()) }, effect as never)),
  ) as Promise<A>

const smoke = (args: Args): Effect.Effect<Outcome, never, unknown> =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const configService = yield* config.get()
    const configured = Object.entries(configService.mcp ?? {}).find(
      ([key, entry]) => key === DRIVER_SERVER || ("command" in entry && (entry.command?.[0] ?? "").includes(DRIVER_SERVER)),
    )
    const mcp = yield* MCP.Service
    // tools() connects the configured servers (lazy) and returns the live tool set.
    let tools = yield* mcp.tools()
    if (!Object.keys(tools).some((key) => key.startsWith(DRIVER_TOOL_PREFIX))) {
      // Config carries no driver server: fall back to the binary on PATH, the same
      // stdio shape the app configures. The tool re-lists tools() after the add.
      yield* mcp.add(DRIVER_SERVER, { type: "local", command: [...DRIVER_FALLBACK_COMMAND] })
      tools = yield* mcp.tools()
    }
    const driverTools = Object.fromEntries(Object.entries(tools).filter(([key]) => key.startsWith(DRIVER_TOOL_PREFIX)))
    if (Object.keys(driverTools).length === 0) {
      return {
        kind: "failed" as const,
        message: `${DRIVER_SERVER} MCP server is not connected (config: ${configured ? "present" : "absent"}, PATH fallback tried)`,
      }
    }

    const listWindows = driverTools[`${DRIVER_SERVER}_list_windows`]
    const getWindowState = driverTools[`${DRIVER_SERVER}_get_window_state`]
    if (listWindows === undefined || getWindowState === undefined) {
      return { kind: "failed" as const, message: `${DRIVER_SERVER} is missing list_windows/get_window_state` }
    }

    const resolved = yield* Effect.gen(function* () {
      if (args.pid !== undefined && args.window !== undefined)
        return { window_id: args.window, pid: args.pid } satisfies WindowRec
      const listed = yield* callDriver(listWindows, {})
      if (!listed.ok) return { error: listed.error }
      const picked = pickWindow(windowsOf(listed.structured))
      return picked ?? { error: "no on-screen window found; open a browser window or pass --pid/--window" }
    })
    if ("error" in resolved) return { kind: "failed" as const, message: `window resolution failed: ${resolved.error}` }
    const window = resolved

    console.log(`[ui-smoke] driver server: ${DRIVER_SERVER}${configured ? ` (config command: ${JSON.stringify(configured[1])})` : " (PATH fallback)"}`)
    console.log(`[ui-smoke] target window: ${describeWindow(window)}`)

    // Pre-flight observation: proves the sensor channel and honours --tree-format.
    const probe = yield* callDriver(getWindowState, {
      pid: window.pid,
      window_id: window.window_id,
      include_screenshot: false,
      tree_format: args.treeFormat,
    })
    if (!probe.ok) return { kind: "failed" as const, message: `pre-flight observation failed: ${probe.error}` }
    const probed = probe.structured as { elements?: unknown[]; element_count?: number } | undefined
    console.log(`[ui-smoke] pre-flight observation: tree_format=${args.treeFormat} elements=${probed?.element_count ?? probed?.elements?.length ?? 0}`)

    // The REAL tool: no second implementation of the loop's decisions.
    const info = yield* UiRunTool
    const def = yield* Tool.init(info)
    const ctx: Tool.Context = {
      sessionID: SessionID.create(),
      messageID: MessageID.ascending(),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }
    const result = yield* def.execute(
      {
        goal: args.goal ?? "",
        window: { pid: window.pid, window_id: window.window_id },
        ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
      },
      ctx,
    )

    console.log(`[ui-smoke] title: ${result.title}`)
    console.log("[ui-smoke] raw output:")
    console.log(result.output)
    const summary = result.metadata as unknown as RunSummary
    console.log(`[ui-smoke] status=${summary.status} plan=${summary.planId ?? "?"}`)
    for (const step of summary.telemetry ?? [])
      console.log(
        `[ui-smoke] step subgoal=${step.subgoalIndex} maneuver=${step.maneuver} strength=${step.strength ?? "n/a"} modes=[${step.deliveryModes.join(",")}] progress=${step.progress.done}/${step.progress.total} reason=${step.reason}`,
      )
    console.log(`[ui-smoke] evidence=${JSON.stringify(summary.evidence ?? [])}`)
    console.log(`[ui-smoke] promotionCandidates=${JSON.stringify(summary.promotionCandidates ?? [])}`)
    if (summary.consent !== undefined) console.log(`[ui-smoke] consent=${JSON.stringify(summary.consent)}`)

    if (result.title.includes("(unavailable)") || result.title.includes("(rejected)"))
      return { kind: "failed" as const, message: result.output }

    return { kind: "ran" as const, window, title: result.title, output: result.output, summary }
  }).pipe(
    Effect.catchCause((cause) => Effect.succeed({ kind: "failed" as const, message: Cause.pretty(cause) })),
  )

const main = async (): Promise<number> => {
  let args: Args
  try {
    args = parseCli(process.argv.slice(2))
  } catch (error) {
    console.error(`ui-smoke: ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    return 2
  }
  if (args.help === true) {
    console.log(USAGE)
    return 0
  }
  if (args.goal === undefined || args.goal.trim().length === 0) {
    console.error("ui-smoke: --goal is required")
    console.error(USAGE)
    return 2
  }
  if ((args.pid === undefined) !== (args.window === undefined)) {
    console.error("ui-smoke: --pid and --window must be given together")
    return 2
  }

  const outcome = await run(smoke(args) as unknown as Effect.Effect<Outcome, unknown, never>)
  if (outcome.kind === "failed") {
    console.error(`ui-smoke: FAILED — ${outcome.message}`)
    return 1
  }
  // A real run that did not complete is reported honestly, not as success.
  if (outcome.summary.status !== "completed") {
    console.error(`ui-smoke: NOT COMPLETED — status=${outcome.summary.status}`)
    return 1
  }
  console.log(`ui-smoke: completed`)
  return 0
}

const code = await main()
await AppRuntime.dispose().catch(() => {})
process.exit(code)
