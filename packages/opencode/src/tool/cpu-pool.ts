// Fixed-size Bun.Worker pool for CPU-heavy tool work (hashing, large-output
// reduction). A runaway hash/truncate should not be able to hold the main event
// loop, which is the single loop every agent fiber shares.
//
// Design constraints:
// - Bounded workers: min(cores - 1, MAX) so the main thread keeps a core
//   free. MAX=12 so a 16-core Mac actually fans out; queue absorbs bursts.
// - Bounded queue with backpressure: past MAX_QUEUE_DEPTH the caller runs the
//   work inline instead of piling up unbounded pending promises.
// - Every task has a deadline (TASK_TIMEOUT_MS). A wedged worker is replaced and
//   the caller gets an error, never a hang.
// - Falls back to inline execution when Worker is unavailable (compiled binary
//   without the worker entrypoint, non-Bun runtime, spawn failure).
import { Effect } from "effect"
import { availableParallelism } from "node:os"
import { createHash } from "node:crypto"
import type { CpuRequest, CpuResponse } from "./cpu-pool.worker"
import { truncateInline } from "./truncate-inline"
import type { TruncateReduction } from "./truncate-inline"

export type { CpuRequest, CpuResponse, TruncateReduction }

const MAX_WORKERS = 12
const MAX_QUEUE_DEPTH = 64
const TASK_TIMEOUT_MS = 30_000

export const POOL_SIZE = Math.max(1, Math.min(availableParallelism() - 1, MAX_WORKERS))

// Dev runs the TypeScript source directly; a compiled binary ships the bundled
// .js next to this module. Prefer whichever exists and let `spawn` fall back to
// inline if neither resolves (stripped build).
const workerTarget = (): URL => new URL("./cpu-pool.worker.ts", import.meta.url)

const sha256Inline = (data: string) => createHash("sha256").update(data).digest("hex")

interface Pending {
  readonly id: number
  readonly request: CpuJob
  readonly resolve: (value: string | TruncateReduction | unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** A job without its correlation id; the pool stamps a unique id per dispatch. */
export type CpuJob =
  | { op: "sha256"; data: string }
  | { op: "truncate"; text: string; maxLines: number; maxBytes: number; direction: "head" | "tail" }
  | { op: "jsonParse"; data: string }

interface Slot {
  readonly worker: Worker
  pending?: Pending
}

// One module-level pool shared by every caller. Workers are expensive to boot
// (tens of ms each) and the workloads are short, so per-call pools would cost
// more than the work itself.
const slots: Slot[] = []
const queue: Pending[] = []
let nextId = 0
let spawning = false
let disabled = false

// Size gate: small payloads stay inline (worker round-trip costs more than the
// work itself); large ones ride the pool so the shared event loop never stalls.
export const POOL_MIN_BYTES = 256 * 1024
const inline = (request: CpuJob): string | TruncateReduction | unknown =>
  request.op === "sha256"
    ? sha256Inline(request.data)
    : request.op === "truncate"
      ? truncateInline(request.text, request.maxLines, request.maxBytes, request.direction)
      : (JSON.parse(request.data) as unknown)

const settle = (pending: Pending, result: { ok: true; value: string | TruncateReduction | unknown } | { ok: false; error: Error }) => {
  clearTimeout(pending.timer)
  if (result.ok) pending.resolve(result.value)
  else pending.reject(result.error)
}

const fail = (pending: Pending, error: Error) => settle(pending, { ok: false, error })

const drain = () => {
  for (const slot of slots) {
    if (slot.pending) continue
    const pending = queue.shift()
    if (!pending) return
    slot.pending = pending
    slot.worker.postMessage({ ...pending.request, id: pending.id })
  }
}

const replace = (slot: Slot) => {
  const pending = slot.pending
  slot.pending = undefined
  slots.splice(slots.indexOf(slot), 1)
  slot.worker.terminate()
  // A witness worker wedged long enough to blow its deadline is abandoned; the
  // caller gets an error rather than a promise that never settles.
  if (pending) fail(pending, new Error("CPU worker timed out"))
  if (queue.length > 0 || pending) spawn()
}

const dispatch = (slot: Slot, response: CpuResponse) => {
  const pending = slot.pending
  if (!pending || pending.id !== response.id) return
  slot.pending = undefined
  if (response.ok) settle(pending, { ok: true, value: response.result })
  else fail(pending, new Error(response.error))
  drain()
}

function spawn() {
  if (disabled || spawning || slots.length >= POOL_SIZE) return
  spawning = true
  try {
    const worker = new Worker(workerTarget())
    const slot: Slot = { worker }
    worker.onmessage = (event: MessageEvent<CpuResponse>) => dispatch(slot, event.data)
    worker.onerror = (event) => {
      const pending = slot.pending
      slot.pending = undefined
      if (pending) fail(pending, new Error(event.message || "CPU worker error"))
      replace(slot)
    }
    slots.push(slot)
    drain()
  } catch {
    // No Worker support (or the entrypoint is absent in a stripped build): run
    // everything inline from here on instead of failing each task.
    disabled = true
  } finally {
    spawning = false
  }
}

const runOnPool = (request: CpuJob): Promise<string | TruncateReduction | unknown> =>
  new Promise<string | TruncateReduction | unknown>((resolve, reject) => {
    spawn()
    if (disabled || slots.length === 0) {
      resolve(inline(request))
      return
    }
    const pending: Pending = {
      id: nextId++,
      request,
      resolve,
      reject,
      timer: setTimeout(() => {
        const slot = slots.find((candidate) => candidate.pending?.id === pending.id)
        if (slot) return replace(slot)
        const index = queue.indexOf(pending)
        if (index >= 0) queue.splice(index, 1)
        fail(pending, new Error("CPU worker timed out"))
      }, TASK_TIMEOUT_MS),
    }
    // Backpressure: refuse to queue unboundedly. Saturation degrades to inline
    // rather than growing the queue without limit.
    if (queue.length + slots.filter((slot) => slot.pending).length >= MAX_QUEUE_DEPTH) {
      clearTimeout(pending.timer)
      resolve(inline(request))
      return
    }
    queue.push(pending)
    drain()
  })

/**
 * Runs CPU-heavy work on the pool. Never fails the caller for pool reasons —
 * it degrades to inline execution — but a worker-side error or deadline is
 * reported so the caller can decide to retry.
 */
export const run = (request: CpuJob): Effect.Effect<string | TruncateReduction | unknown, Error> =>
  Effect.tryPromise({
    try: () => runOnPool(request),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

/** Test/shutdown hook: terminate every worker and drop queued work. */
export const shutdown = (): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const slot of slots) {
      slot.worker.terminate()
      if (slot.pending) fail(slot.pending, new Error("CPU pool shut down"))
    }
    slots.length = 0
    for (const pending of queue.splice(0)) fail(pending, new Error("CPU pool shut down"))
  })

export const sha256 = (data: string) => run({ op: "sha256", data })

// Parses JSON off the main loop when large; small payloads stay inline.
// Falls back to inline on pool failure — never fails the caller for pool reasons.
export const jsonParse = (data: string) =>
  data.length < POOL_MIN_BYTES
    ? Effect.sync(() => JSON.parse(data) as unknown)
    : run({ op: "jsonParse", data }).pipe(
        Effect.catch(() => Effect.sync(() => JSON.parse(data) as unknown)),
      )

// Pool size (workers) is POOL_SIZE; queue depth MAX_QUEUE_DEPTH.

export const truncate = (text: string, maxLines: number, maxBytes: number, direction: "head" | "tail") =>
  run({ op: "truncate", text, maxLines, maxBytes, direction })

export const isAvailable = () => !disabled

// Narrows the widened pool result (string | TruncateReduction | unknown) back
// to a reduction after the caller has excluded strings.
export const isReduction = (value: unknown): value is TruncateReduction => {
  if (typeof value !== "object" || value === null) return false
  const content = (value as { content?: unknown }).content
  return typeof content === "string"
}

export * as CpuPool from "./cpu-pool"
