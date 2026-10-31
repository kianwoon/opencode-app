import { authTokenFromCredentials } from "@/runtime/server/api"

// The assignable inventory is served by the experimental HttpApi at
// /mcp/inventory, which is NOT part of the generated client contract, so the
// panels read it over plain fetch instead of serverSDK().client.
export type ToolInventory = {
  registry: { id: string; description?: string }[]
  mcp: { server: string; tools: { name: string; description?: string }[] }[]
}

// A production server may not serve /mcp/inventory at all (404 with an empty
// body). That is a state, not an exception: return undefined so the panels can
// render "not available on this server". A proxy that does not forward the path
// answers the SPA shell with a 200 instead, so any non-JSON body is "unavailable"
// too and never reaches JSON.parse ("Unexpected token '<'").
export async function fetchToolInventory(server: {
  url: string
  username?: string
  password?: string
}): Promise<ToolInventory | undefined> {
  const headers = server.password
    ? {
        Authorization: `Basic ${authTokenFromCredentials({ password: server.password })}`,
      }
    : undefined
  const response = await fetch(`${server.url}/mcp/inventory`, { headers })
  if (!response.ok) return undefined
  const contentType = response.headers.get("content-type")
  if (contentType !== null && !contentType.includes("application/json")) return undefined
  const body = await response.text()
  if (body.trim() === "") return undefined
  const value = parseJSON(body)
  if (!isToolInventory(value)) return undefined
  return value
}

function parseJSON(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function isToolInventory(value: unknown): value is ToolInventory {
  if (!value || typeof value !== "object") return false
  const record = value as { registry?: unknown; mcp?: unknown }
  return Array.isArray(record.registry) && Array.isArray(record.mcp)
}
