import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { ChunkStallError, wrapSSE } from "../src/aisdk"

async function heartbeatServer(options: { interval: number; duration: number }): Promise<{
  server: Server
  url: string
}> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const id = setInterval(() => res.write(": ping\n\n"), options.interval)
    setTimeout(() => {
      clearInterval(id)
      res.end("data: [DONE]\n\n")
    }, options.duration)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    text += decoder.decode(part.value, { stream: true })
  }
  return text
}

describe("core wrapSSE payload-only stall guard", () => {
  test("heartbeat-only stream still stalls at the deadline", async () => {
    const { server, url } = await heartbeatServer({ interval: 10, duration: 30_000 })
    try {
      const res = await fetch(url)
      const guarded = wrapSSE(res, 400, new AbortController())
      const error = await readAll(guarded).then(
        () => undefined,
        (err) => err as unknown,
      )
      expect(error).toBeInstanceOf(ChunkStallError)
      expect((error as ChunkStallError).name).toBe("ProviderChunkStallError")
      expect((error as ChunkStallError).ms).toBe(400)
    } finally {
      server.close()
    }
  })

  test("healthy spaced-payload stream does not stall", async () => {
    const server = createServer((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"a":1}\n\n')
      setTimeout(() => res.write('data: {"b":2}\n\n'), 30)
      setTimeout(() => res.end("data: [DONE]\n\n"), 60)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}`)
      const guarded = wrapSSE(res, 500, new AbortController())
      const text = await readAll(guarded)
      expect(text).toContain('"a":1')
      expect(text).toContain('"b":2')
    } finally {
      server.close()
    }
  })
})
