import { authTokenFromCredentials } from "@/runtime/server/api"

// The assignable inventory is served by the experimental HttpApi at
// /mcp/inventory, which is NOT part of the generated client contract, so the
// panels read it over plain fetch instead of serverSDK().client.
export type ToolInventory = {
  registry: { id: string; description?: string }[]
  mcp: { server: string; tools: { name: string; description?: string }[] }[]
}

export async function fetchToolInventory(server: {
  url: string
  username?: string
  password?: string
}): Promise<ToolInventory> {
  const headers = server.password
    ? {
        Authorization: `Basic ${authTokenFromCredentials({ password: server.password })}`,
      }
    : undefined
  const response = await fetch(`${server.url}/mcp/inventory`, { headers })
  return (await response.json()) as ToolInventory
}