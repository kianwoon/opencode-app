import { Option, Schema } from "effect"

export type ProtocolFamily = "openai" | "anthropic"

// Bedrock shapes are intentionally unclassified; only the Anthropic SDKs map to "anthropic".
export function protocolFromNpm(npm: string): ProtocolFamily {
  const isAnthropic = npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic"
  return isAnthropic ? "anthropic" : "openai"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function classifyProtocolError(raw: string): ProtocolFamily | undefined {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw))
  if (!isRecord(decoded)) return undefined
  const rootType = decoded["type"]
  const inner = decoded["error"]
  if (!isRecord(inner)) return undefined
  if (rootType === "error") {
    const innerType = inner["type"]
    return typeof innerType === "string" && innerType.endsWith("_error") ? "anthropic" : undefined
  }
  const message = inner["message"]
  if (typeof message !== "string") return undefined
  const innerType = inner["type"]
  const code = inner["code"]
  const hasTypeOrCode =
    typeof innerType === "string" || typeof code === "string" || typeof code === "number"
  return hasTypeOrCode ? "openai" : undefined
}

export function suggestProtocolFromBaseURL(url: string): ProtocolFamily | undefined {
  const lower = url.toLowerCase()
  const isAnthropic = lower.includes("anthropic") || lower.includes("/v1/messages")
  return isAnthropic ? "anthropic" : undefined
}
