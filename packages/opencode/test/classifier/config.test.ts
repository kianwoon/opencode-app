import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

import { ConfigClassifierV1 } from "@opencode-ai/core/v1/config/classifier"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

describe("classifier config", () => {
  test("all fields are optional and default to empty", () => {
    const decoded = Schema.decodeUnknownSync(ConfigClassifierV1.Info)({})
    expect(decoded).toEqual({})
  })

  test("decodes the full shape with snake_case fields", () => {
    const decoded = Schema.decodeUnknownSync(ConfigClassifierV1.Info)({
      enabled: true,
      retry: true,
      model: "jev-latest",
      max_attempts: 5,
      thresholds: { retry_switch: { accept: 0.8 } },
    })
    expect(decoded.enabled).toBe(true)
    expect(decoded.retry).toBe(true)
    expect(decoded.model).toBe("jev-latest")
    expect(decoded.max_attempts).toBe(5)
    expect(decoded.thresholds?.retry_switch?.accept).toBe(0.8)
  })

  test("registers on the root config beside brain", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({
      brain: { model: "provider/model" },
      classifier: { enabled: false, model: "jev-latest" },
    })
    expect(decoded.classifier?.model).toBe("jev-latest")
  })

  test("root config accepts a missing classifier block", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({})
    expect(decoded.classifier).toBeUndefined()
  })
})
