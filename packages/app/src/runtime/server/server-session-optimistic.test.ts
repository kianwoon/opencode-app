import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { mergeOptimisticPage } from "@/context/server-session"

function userMessage(id: string, created: number): Message {
  return {
    id,
    sessionID: "ses_test",
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  } as Message
}

describe("mergeOptimisticPage id-first matching", () => {
  test("optimistic entry and confirmed server message with same id but different time.created collapse into one", () => {
    // Client sends messageID (dup-prevention fix) with its own clock at
    // optimistic-add time; the server persists the real message with the
    // server clock. Same id, different time.created.
    const confirmed = userMessage("msg_same", 1_000)
    const optimistic = {
      sessionID: "ses_test",
      message: userMessage("msg_same", 1_200),
      parts: [{ type: "text", text: "hello" } as Part],
    }

    const page = {
      source: [],
      session: [confirmed],
      part: [{ id: "msg_same", part: [{ type: "text", text: "hello" } as Part] }],
      complete: true,
    }

    const merged = mergeOptimisticPage(page as any, [optimistic as any])
    const withID = merged.session.filter((message) => message.id === "msg_same")
    expect(withID).toHaveLength(1)
  })

  test("distinct optimistic messages still insert in messageKey order", () => {
    const page = {
      source: [],
      session: [userMessage("msg_a", 1_000)],
      part: [],
      complete: true,
    }
    const optimistic = {
      sessionID: "ses_test",
      message: userMessage("msg_b", 2_000),
      parts: [],
    }
    const merged = mergeOptimisticPage(page as any, [optimistic as any])
    expect(merged.session.map((message) => message.id)).toEqual(["msg_a", "msg_b"])
  })
})
