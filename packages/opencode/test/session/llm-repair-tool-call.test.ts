import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { makeRepairToolCall } from "../../src/session/llm/request"

const dummy = tool({
  description: "x",
  inputSchema: jsonSchema({ type: "object", properties: {} }),
  execute: async () => "",
})

const failed = (toolName: string, error: { name: string; message: string }) =>
  ({
    toolCall: { type: "tool-call", toolCallId: "c1", toolName, input: "{}" },
    tools: {},
    error,
  }) as any

describe("makeRepairToolCall", () => {
  test("unknown tool without invalid registered returns null", async () => {
    const repair = makeRepairToolCall({ bash: dummy } as any)
    const result = await repair(
      failed("cua-driver_get_accessibility_tree", {
        name: "AI_NoSuchToolError",
        message: "Model tried to call unavailable tool 'cua-driver_get_accessibility_tree'",
      }),
    )
    expect(result).toBeNull()
  })

  test("invalid tool input with invalid registered repairs to invalid", async () => {
    const repair = makeRepairToolCall({ bash: dummy, invalid: dummy } as any)
    const result = await repair(
      failed("bash", { name: "AI_InvalidToolInputError", message: "bad input" }),
    )
    expect(result?.toolName).toBe("invalid")
    expect(JSON.parse((result as any).input)).toEqual({ tool: "bash", error: "bad input" })
  })

  test("invalid tool input without invalid registered returns null", async () => {
    const repair = makeRepairToolCall({ bash: dummy } as any)
    const result = await repair(
      failed("bash", { name: "AI_InvalidToolInputError", message: "bad input" }),
    )
    expect(result).toBeNull()
  })

  test("mis-cased known tool name recovers to lowercase", async () => {
    const repair = makeRepairToolCall({ bash: dummy } as any)
    const result = await repair(
      failed("Bash", { name: "AI_NoSuchToolError", message: "unknown tool" }),
    )
    expect(result?.toolName).toBe("bash")
  })
})
