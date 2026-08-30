import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assetMimeType, parseByteRange, resolveRendererAsset, serveRendererAsset } from "./renderer-protocol"

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "opencode-renderer-protocol-"))
  roots.push(root)
  return root
}

async function writeAsset(root: string, name: string, body: string | Uint8Array) {
  const file = join(root, name)
  await mkdir(join(file, ".."), { recursive: true })
  await writeFile(file, body)
}

const htmlRequest = (path: string, headers?: Record<string, string>) => new Request(`oc://renderer${path}`, { headers })

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("renderer protocol", () => {
  describe("resolveRendererAsset", () => {
    test("resolves paths inside the renderer root", async () => {
      const root = await tempRoot()
      expect(resolveRendererAsset("/index.html", root)).toBe(join(root, "index.html"))
      expect(resolveRendererAsset("/assets/main-1.js", root)).toBe(join(root, "assets/main-1.js"))
    })

    test("decodes percent-encoded paths", async () => {
      const root = await tempRoot()
      const dir = join(root, "with space")
      await writeAsset(root, "with space/file.txt", "x")
      expect(resolveRendererAsset("/with%20space/file.txt", root)).toBe(join(dir, "file.txt"))
    })

    test("rejects traversal outside the renderer root", async () => {
      const root = await tempRoot()
      expect(resolveRendererAsset("/../secret.txt", root)).toBeUndefined()
      expect(resolveRendererAsset("/assets/../../secret.txt", root)).toBeUndefined()
      expect(resolveRendererAsset("/%2e%2e/secret.txt", root)).toBeUndefined()
    })

    test("rejects malformed percent-encoding", () => {
      expect(resolveRendererAsset("/%zz", "/tmp/x")).toBeUndefined()
    })
  })

  describe("assetMimeType", () => {
    test("maps known extensions", () => {
      expect(assetMimeType("a.js")).toBe("application/javascript")
      expect(assetMimeType("a.mjs")).toBe("application/javascript")
      expect(assetMimeType("a.css")).toBe("text/css; charset=utf-8")
      expect(assetMimeType("a.html")).toBe("text/html; charset=utf-8")
      expect(assetMimeType("a.TTF")).toBe("font/ttf")
      expect(assetMimeType("a.woff2")).toBe("font/woff2")
      expect(assetMimeType("a.wasm")).toBe("application/wasm")
    })

    test("falls back to octet-stream for unknown extensions", () => {
      expect(assetMimeType("a.unknown")).toBe("application/octet-stream")
      expect(assetMimeType("noext")).toBe("application/octet-stream")
    })
  })

  describe("parseByteRange", () => {
    test("returns undefined without a header", () => {
      expect(parseByteRange(null, 100)).toBeUndefined()
    })

    test("parses suffix and explicit ranges", () => {
      expect(parseByteRange("bytes=0-49", 100)).toEqual({ start: 0, end: 49 })
      expect(parseByteRange("bytes=50-", 100)).toEqual({ start: 50, end: 99 })
      expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 })
      expect(parseByteRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 })
    })

    test("marks malformed and unsatisfiable ranges", () => {
      expect(parseByteRange("bytes=", 100)).toBe("invalid")
      expect(parseByteRange("items=0-1", 100)).toBe("invalid")
      expect(parseByteRange("bytes=-", 100)).toBe("invalid")
      expect(parseByteRange("bytes=-0", 100)).toBe("invalid")
      expect(parseByteRange("bytes=100-", 100)).toBe("invalid")
      expect(parseByteRange("bytes=60-50", 100)).toBe("invalid")
      expect(parseByteRange("bytes=-5", 0)).toBe("invalid")
    })
  })

  describe("serveRendererAsset", () => {
    test("serves file bytes with explicit content type and no-store", async () => {
      const root = await tempRoot()
      await writeAsset(root, "assets/app.js", "console.log('hi')")
      const response = await serveRendererAsset(htmlRequest("/assets/app.js"), root)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/javascript")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("accept-ranges")).toBe("bytes")
      expect(await response.text()).toBe("console.log('hi')")
    })

    test("serves binary bytes without transformation", async () => {
      const root = await tempRoot()
      const bytes = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x3c, 0x68])
      await writeAsset(root, "assets/Inter.ttf", bytes)
      const response = await serveRendererAsset(htmlRequest("/assets/Inter.ttf"), root)
      expect(response.headers.get("content-type")).toBe("font/ttf")
      const body = new Uint8Array(await response.arrayBuffer())
      expect(body).toEqual(bytes)
    })

    test("returns 404 for missing files and rejected paths", async () => {
      const root = await tempRoot()
      expect((await serveRendererAsset(htmlRequest("/missing.js"), root)).status).toBe(404)
      expect((await serveRendererAsset(htmlRequest("/../secret"), root)).status).toBe(404)
      expect((await serveRendererAsset(new Request("oc://other/index.html"), root)).status).toBe(404)
    })

    test("serves a byte range with 206 and content-range", async () => {
      const root = await tempRoot()
      await writeAsset(root, "assets/blob.bin", "0123456789")
      const response = await serveRendererAsset(htmlRequest("/assets/blob.bin", { range: "bytes=2-5" }), root)
      expect(response.status).toBe(206)
      expect(response.headers.get("content-range")).toBe("bytes 2-5/10")
      expect(response.headers.get("content-length")).toBe("4")
      expect(await response.text()).toBe("2345")
    })

    test("sets the document policy header only on html", async () => {
      const root = await tempRoot()
      await writeAsset(root, "index.html", "<html></html>")
      await writeAsset(root, "assets/app.js", "x")
      const html = await serveRendererAsset(htmlRequest("/index.html"), root)
      expect(html.headers.get("Document-Policy")).toBe("include-js-call-stacks-in-crash-reports")
      const js = await serveRendererAsset(htmlRequest("/assets/app.js"), root)
      expect(js.headers.get("Document-Policy")).toBeNull()
    })
  })
})
