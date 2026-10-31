import { afterEach, expect, test } from "bun:test"
import { fetchToolInventory, type ToolInventory } from "./tool-inventory"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const inventory: ToolInventory = { registry: [{ id: "read" }], mcp: [{ server: "docs", tools: [{ name: "search" }] }] }

function respond(body: string, init: ResponseInit) {
  globalThis.fetch = (async () => new Response(body, init)) as unknown as typeof globalThis.fetch
}

test("an HTML shell body is unavailable", async () => {
  respond("<!doctype html><html><body></body></html>", { status: 200, headers: { "content-type": "text/html" } })
  expect(await fetchToolInventory({ url: "http://server" })).toBeUndefined()
})

test("a JSON body is the inventory", async () => {
  respond(JSON.stringify(inventory), { status: 200, headers: { "content-type": "application/json" } })
  expect(await fetchToolInventory({ url: "http://server" })).toEqual(inventory)
})

test("a 404 is unavailable", async () => {
  respond("", { status: 404 })
  expect(await fetchToolInventory({ url: "http://server" })).toBeUndefined()
})
