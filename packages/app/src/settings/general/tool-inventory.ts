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
// render "not available on this server", and never call response.json() on a
// body that is not there.
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
  const body = await response.text()
  if (body.trim() === "") return undefined
  const value: unknown = JSON.parse(body)
  if (!isToolInventory(value)) return undefined
  return value
}

function isToolInventory(value: unknown): value is ToolInventory {
  if (!value || typeof value !== "object") return false
  const record = value as { registry?: unknown; mcp?: unknown }
  return Array.isArray(record.registry) && Array.isArray(record.mcp)
}
