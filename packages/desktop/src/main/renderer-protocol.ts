import { promises as fsPromises, createReadStream } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
export const rendererRoot = join(root, "../renderer")

export const rendererProtocol = "oc"
export const rendererHost = "renderer"

// Diagnostics only. Dynamically imported so the electron-log module graph
// (and Electron itself) stays out of unit tests.
const log = async (message: string, extra: Record<string, unknown>, level: "info" | "warn" | "error" = "info") => {
  try {
    const { write } = await import("./logging")
    write("protocol", message, extra, level)
  } catch {
    // Logging is best-effort; serving must not depend on it.
  }
}

const documentPolicyHeader = "Document-Policy"
const jsCallStacksDocumentPolicy = "include-js-call-stacks-in-crash-reports"

// Renderer assets ship inside the app bundle, so the set is closed. Unknown
// extensions fall back to application/octet-stream rather than guessing.
const assetMimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
}

export function assetMimeType(file: string) {
  return assetMimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream"
}

export function resolveRendererAsset(pathname: string, base = rendererRoot) {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  const file = resolve(base, `.${decoded}`)
  const rel = relative(base, file)
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined
  return file
}

type ByteRange = { start: number; end: number }

export function parseByteRange(header: string | null, size: number): ByteRange | "invalid" | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return "invalid"
  if (match[1] === "") {
    const length = Number(match[2])
    if (length === 0 || size === 0) return "invalid"
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(match[1])
  if (start >= size) return "invalid"
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (end < start) return "invalid"
  return { start, end }
}

const statFile = (file: string) => fsPromises.stat(file)

function notFound(url: string, file: string | undefined, error: unknown) {
  void log("read error", { url, file, error }, "error")
  return new Response("Not found", { status: 404 })
}

/**
 * Serves renderer bundle files for the privileged `oc://` protocol.
 *
 * Reads bytes directly from disk instead of `net.fetch(pathToFileURL(...))`:
 * the file:// fetch path has served corrupted bytes for concurrent asset
 * requests (JS evaluated as HTML, fonts failing OTS parsing), which the app
 * surface sees as SyntaxError crashes. An explicit fs stream with explicit
 * headers cannot mix up bodies or Content-Type.
 *
 * Responses are `no-store`: hashed asset names make caching worthless here,
 * and refusing the HTTP cache means a poisoned cache entry can never shadow
 * the real file on disk.
 */
export async function serveRendererAsset(request: Request, base = rendererRoot) {
  const url = new URL(request.url)
  if (url.host !== rendererHost) {
    void log("rejected host", { url: request.url }, "warn")
    return new Response("Not found", { status: 404 })
  }

  const file = resolveRendererAsset(url.pathname, base)
  if (!file) {
    void log("rejected path", { url: request.url, file }, "warn")
    return new Response("Not found", { status: 404 })
  }

  let stats
  try {
    stats = await statFile(file)
  } catch (error) {
    return notFound(request.url, file, error)
  }
  if (!stats.isFile()) return notFound(request.url, file, new Error("not a regular file"))

  const range = parseByteRange(request.headers.get("range"), stats.size)
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${stats.size}` },
    })
  }

  const headers = new Headers({
    "content-type": assetMimeType(file),
    "content-length": String(range ? range.end - range.start + 1 : stats.size),
    "cache-control": "no-store",
    "accept-ranges": "bytes",
  })
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${stats.size}`)

  const stream = createReadStream(file, range ? { start: range.start, end: range.end } : undefined)
  const response = new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  })
  if (!file.toLowerCase().endsWith(".html")) return response

  // HTML entrypoints opt into JS call stacks in crash reports.
  const withPolicy = new Headers(response.headers)
  withPolicy.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: withPolicy })
}

export function registerRendererProtocol(protocol: Electron.Protocol) {
  if (protocol.isProtocolHandled(rendererProtocol)) return
  protocol.handle(rendererProtocol, (request) => serveRendererAsset(request))
}
