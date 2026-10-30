// Worker side of the CPU pool (see cpu-pool.ts). Receives one request at a time
// per worker, returns one result. Kept dependency-free so it stays cheap to
// boot and cannot pull the app graph into a worker thread.
import { createHash } from "node:crypto"
import { truncateInline, type TruncateReduction } from "./truncate-inline"

export type CpuRequest =
  | { id: number; op: "sha256"; data: string }
  | { id: number; op: "truncate"; text: string; maxLines: number; maxBytes: number; direction: "head" | "tail" }
  | { id: number; op: "jsonParse"; data: string }

export type CpuResponse =
  | { id: number; ok: true; result: string | TruncateReduction | unknown }
  | { id: number; ok: false; error: string }

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex")

const handle = (req: CpuRequest): string | TruncateReduction | unknown =>
  req.op === "sha256"
    ? sha256(req.data)
    : req.op === "truncate"
      ? truncateInline(req.text, req.maxLines, req.maxBytes, req.direction)
      : (JSON.parse(req.data) as unknown)

declare const self: {
  onmessage: ((event: MessageEvent<CpuRequest>) => void) | null
  postMessage: (message: CpuResponse) => void
}

self.onmessage = (event) => {
  const req = event.data
  // Shape errors are reported back rather than thrown: the caller always needs a
  // settled response or its timeout will fire on a worker that is actually idle.
  try {
    self.postMessage({ id: req.id, ok: true, result: handle(req) })
  } catch (error) {
    self.postMessage({ id: req.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
