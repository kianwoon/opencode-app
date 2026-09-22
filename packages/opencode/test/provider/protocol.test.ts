import { describe, expect, test } from "bun:test"
import { classifyProtocolError, protocolFromNpm, suggestProtocolFromBaseURL } from "../../src/provider/protocol"

describe("protocol", () => {
  test("openai wrapped anthropic not_found maps to openai", () => {
    expect(
      classifyProtocolError('{"error":{"message":"Invalid URL (POST /v1/messages)","type":"invalid_request_error","param":null,"code":null}}'),
    ).toBe("openai")
  })
  test("anthropic not_found maps to anthropic", () => {
    expect(
      classifyProtocolError('{"type":"error","error":{"type":"not_found_error","message":"url: https://api.anthropic.com/v1/chat/completions"}}'),
    ).toBe("anthropic")
  })
  test("anthropic auth error maps to anthropic", () => {
    expect(
      classifyProtocolError('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
    ).toBe("anthropic")
  })
  test("openai numeric code maps to openai", () => {
    expect(classifyProtocolError('{"error":{"message":"No allowed providers are available","code":404}}')).toBe("openai")
  })
  test("html payload maps to undefined", () => {
    expect(classifyProtocolError("<!DOCTYPE html><html><body>gateway</body></html>")).toBeUndefined()
  })
  test("empty payload maps to undefined", () => {
    expect(classifyProtocolError("")).toBeUndefined()
  })
  test("protocolFromNpm", () => {
    expect(protocolFromNpm("@ai-sdk/anthropic")).toBe("anthropic")
    expect(protocolFromNpm("@ai-sdk/google-vertex/anthropic")).toBe("anthropic")
    expect(protocolFromNpm("@ai-sdk/openai-compatible")).toBe("openai")
    expect(protocolFromNpm("")).toBe("openai")
  })
  test("suggestProtocolFromBaseURL", () => {
    expect(suggestProtocolFromBaseURL("https://api.anthropic.com/v1")).toBe("anthropic")
    expect(suggestProtocolFromBaseURL("https://api.z.ai/api/anthropic")).toBe("anthropic")
    expect(suggestProtocolFromBaseURL("https://api.z.ai/v1")).toBeUndefined()
    expect(suggestProtocolFromBaseURL("https://openrouter.ai/api/v1")).toBeUndefined()
  })
})
