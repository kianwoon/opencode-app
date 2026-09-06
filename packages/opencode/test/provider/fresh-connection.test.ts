import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider, needsFreshConnections, fetchFreshConnection } from "@/provider/provider"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Env.node, Plugin.node, CrossSpawnSpawner.node, Provider.node])),
)

describe("needsFreshConnections", () => {
  test("matches z.ai, bigmodel and openrouter hosts on any subdomain", () => {
    expect(needsFreshConnections("https://api.z.ai/api/coding/paas/v4")).toBe(true)
    expect(needsFreshConnections("https://open.bigmodel.cn/api/paas/v4")).toBe(true)
    expect(needsFreshConnections("https://openrouter.ai/api/v1")).toBe(true)
    expect(needsFreshConnections("https://z.ai")).toBe(true)
  })

  test("does not match other providers or invalid urls", () => {
    expect(needsFreshConnections("https://api.openai.com/v1")).toBe(false)
    expect(needsFreshConnections("https://api.deepseek.com/v1")).toBe(false)
    expect(needsFreshConnections("https://evilz.ai.example.com/v1")).toBe(false)
    expect(needsFreshConnections("https://evilopenrouter.ai.example.com/v1")).toBe(false)
    expect(needsFreshConnections(undefined)).toBe(false)
    expect(needsFreshConnections("not a url")).toBe(false)
  })
})

describe("fetchFreshConnection", () => {
  // Count distinct client ports: one per TCP connection. A pooled keep-alive
  // client reuses one port across sequential requests; the wrapper must show
  // a different port per request.
  function connectionCountingServer() {
    const ports: number[] = []
    const server = createServer((req, res) => {
      const remote = req.socket.remotePort
      if (remote) ports.push(remote)
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ok")
    })
    const ready = new Promise<{ server: Server; url: string; ports: number[] }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
        resolve({ server, url: `http://127.0.0.1:${address.port}`, ports })
      })
    })
    return { ready, close: () => server.close() }
  }

  test("uses a new connection per request", async () => {
    const srv = await connectionCountingServer().ready
    try {
      for (let i = 0; i < 4; i++) {
        const res = await fetchFreshConnection(srv.url + "/v1/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ i }),
        })
        expect(res.status).toBe(200)
        expect(await res.text()).toBe("ok")
      }
      expect(srv.ports.length).toBe(4)
      expect(new Set(srv.ports).size).toBe(4)
    } finally {
      srv.server.close()
    }
  })

  test("propagates request headers and body", async () => {
    let seen: { auth?: string; body?: string } = {}
    const server = createServer((req, res) => {
      let buf = ""
      req.on("data", (c) => (buf += c))
      req.on("end", () => {
        seen = { auth: req.headers["authorization"], body: buf }
        res.writeHead(200, { "content-type": "application/json" })
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no port")
    try {
      const res = await fetchFreshConnection(`http://127.0.0.1:${address.port}/v1/x`, {
        method: "POST",
        headers: { authorization: "Bearer test-key" },
        body: JSON.stringify({ hello: "world" }),
      })
      expect(await res.json()).toEqual({ ok: true })
      expect(seen.auth).toBe("Bearer test-key")
      expect(JSON.parse(seen.body ?? "{}")).toEqual({ hello: "world" })
    } finally {
      server.close()
    }
  })

  test("surfaces non-2xx responses with status intact", async () => {
    const server = createServer((_, res) => {
      res.writeHead(429, { "content-type": "application/json" })
      res.end('{"error":"rate limited"}')
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no port")
    try {
      const res = await fetchFreshConnection(`http://127.0.0.1:${address.port}/v1/x`, { method: "POST" })
      expect(res.status).toBe(429)
      expect(await res.text()).toBe('{"error":"rate limited"}')
    } finally {
      server.close()
    }
  })
})
