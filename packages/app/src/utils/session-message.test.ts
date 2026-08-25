import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import {
  contextForMessageAt,
  normalizeMessage,
  normalizeSessionMessages,
  type NormalizeContext,
} from "./session-message"

describe("normalizeSessionMessages", () => {
  test("projects current turns into stable legacy rendering records", () => {
    const source = [
      { id: "msg_1", type: "agent-switched", agent: "build", time: { created: 1 } },
      {
        id: "msg_2",
        type: "model-switched",
        model: { id: "claude", providerID: "anthropic", variant: "high" },
        time: { created: 2 },
      },
      {
        id: "msg_3",
        type: "user",
        text: "inspect @src/client.ts",
        files: [
          {
            data: "aGVsbG8=",
            mime: "text/plain",
            name: "note.txt",
            source: { type: "inline" },
          },
          {
            data: "ZXhwb3J0IHt9",
            mime: "text/plain",
            name: "client.ts",
            source: { type: "inline" },
            mention: { text: "@src/client.ts", start: 8, end: 22 },
          },
        ],
        agents: [{ name: "review", mention: { text: "@review", start: 0, end: 7 } }],
        time: { created: 3 },
      },
      {
        id: "msg_4",
        type: "assistant",
        agent: "build",
        model: { id: "claude", providerID: "anthropic", variant: "high" },
        content: [
          { type: "reasoning", text: "Thinking", time: { created: 4, completed: 5 } },
          { type: "text", text: "Result" },
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "note.txt" },
              metadata: { title: "note.txt" },
              content: [{ type: "text", text: "hello" }],
            },
            time: { created: 5, ran: 6, completed: 7 },
          },
        ],
        cost: 0.1,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
        time: { created: 4, completed: 7 },
      },
      {
        id: "msg_5",
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "summary",
        recent: "recent",
        time: { created: 8 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toMatchObject({
      id: "msg_3",
      role: "user",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude", variant: "high" },
    })
    expect(result.messages[1]).toMatchObject({ id: "msg_4", role: "assistant", parentID: "msg_3", cost: 0.1 })
    expect(result.parts.get("msg_3")?.map((part) => part.id)).toEqual([
      "msg_3:text:0",
      "msg_3:file:0",
      "msg_3:file:1",
      "msg_3:agent:0",
      "msg_5:compaction",
    ])
    expect(result.parts.get("msg_3")?.[2]).toMatchObject({
      type: "file",
      source: {
        type: "file",
        path: "src/client.ts",
        text: { value: "@src/client.ts", start: 8, end: 22 },
      },
    })
    expect(result.parts.get("msg_4")?.map((part) => part.id)).toEqual(["msg_4:reasoning:0", "msg_4:text:0", "call_1"])
    expect(result.parts.get("msg_4")?.[2]).toMatchObject({
      type: "tool",
      tool: "read",
      state: { status: "completed", output: "hello" },
    })
  })

  test("does not invent a parent for an assistant-only page", () => {
    const source = [
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "orphan" }],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    expect(normalizeSessionMessages("ses_1", source).messages).toEqual([])
  })

  test("projects a current shell message into a renderable standalone turn", () => {
    const source = [
      {
        id: "msg_shell",
        type: "shell",
        shellID: "shell_1",
        command: "printf hello",
        status: "exited",
        exit: 0,
        output: { output: "hello", cursor: 5, size: 5, truncated: false },
        time: { created: 1, completed: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.messages).toEqual([
      expect.objectContaining({ id: "msg_shell", role: "user" }),
      expect.objectContaining({ id: "msg_shell:assistant", role: "assistant", parentID: "msg_shell" }),
    ])
    expect(result.parts.get("msg_shell")).toEqual([expect.objectContaining({ type: "text", text: "printf hello" })])
    expect(result.parts.get("msg_shell:assistant")).toEqual([
      expect.objectContaining({
        type: "tool",
        tool: "bash",
        state: expect.objectContaining({
          status: "completed",
          input: { command: "printf hello" },
          output: "hello",
          title: "Shell",
        }),
      }),
    ])
  })

  test("adapts current edit fields for the legacy edit renderer", () => {
    const source = [
      { id: "msg_user", type: "user", text: "edit it", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "call_edit",
            name: "edit",
            state: {
              status: "completed",
              input: { path: "/repo/README.md", oldString: "old", newString: "new" },
              content: [{ type: "text", text: "Edited file successfully" }],
              metadata: {
                files: [
                  {
                    file: "README.md",
                    patch: "@@ -1 +1 @@\n-old\n+new",
                    additions: 1,
                    deletions: 1,
                    status: "modified",
                  },
                ],
                replacements: 1,
              },
            },
            time: { created: 2, ran: 3, completed: 4 },
          },
        ],
        time: { created: 2, completed: 4 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.parts.get("msg_assistant")).toEqual([
      expect.objectContaining({
        type: "tool",
        tool: "edit",
        state: expect.objectContaining({
          status: "completed",
          input: expect.objectContaining({ path: "/repo/README.md", filePath: "/repo/README.md" }),
          metadata: expect.objectContaining({
            filediff: {
              file: "README.md",
              patch: "@@ -1 +1 @@\n-old\n+new",
              additions: 1,
              deletions: 1,
            },
          }),
        }),
      }),
    ])
  })
})

describe("normalizeMessage + contextForMessageAt", () => {
  test("produces the same per-message output as normalizeSessionMessages", () => {
    const source: SessionMessageInfo[] = [
      { id: "a", type: "agent-switched", agent: "build", time: { created: 1 } } as never,
      {
        id: "m1",
        type: "model-switched",
        model: { id: "claude", providerID: "anthropic", variant: "high" },
        time: { created: 2 },
      } as never,
      {
        id: "u1",
        type: "user",
        text: "hi",
        time: { created: 3 },
      } as never,
      {
        id: "as1",
        type: "assistant",
        agent: "build",
        model: { id: "claude", providerID: "anthropic" },
        time: { created: 4 },
        content: [
          { type: "text", text: "hello" },
          { type: "reasoning", text: "thinking", time: { created: 4 } },
        ],
      } as never,
      {
        id: "u2",
        type: "user",
        text: "next",
        time: { created: 5 },
      } as never,
      {
        id: "as2",
        type: "assistant",
        agent: "build",
        model: { id: "claude", providerID: "anthropic" },
        time: { created: 6 },
        content: [
          { type: "text", text: "world" },
          {
            type: "tool",
            id: "call_1",
            name: "bash",
            time: { created: 6, ran: 6, completed: 7 },
            state: {
              status: "completed",
              input: {},
              metadata: {},
              content: [{ type: "text", text: "ok" }],
            },
          },
        ],
        finish: "stop",
      } as never,
    ] as never

    const full = normalizeSessionMessages("ses_1", source)

    // For each message that produces output, normalizeMessage must match.
    let runningAgent = ""
    let runningModel: { id: string; providerID: string; variant?: string } = { id: "", providerID: "" }
    let runningParent: string | undefined
    for (let i = 0; i < source.length; i++) {
      const m = source[i]!
      if (m.type === "agent-switched") runningAgent = (m as { agent: string }).agent
      else if (m.type === "model-switched") runningModel = (m as { model: { id: string; providerID: string; variant?: string } }).model
      else if (m.type === "user" || (m.type === "synthetic" && (m as { description?: string }).description?.trim())) runningParent = m.id
      else if (m.type === "shell") runningParent = undefined
      else if (m.type === "assistant") {
        runningAgent = m.agent
        runningModel = m.model
      } else continue

      const context = { parentID: runningParent, agent: runningAgent, model: runningModel }
      const one = normalizeMessage("ses_1", m, context)
      // The full normalize's messages[] and parts map may carry forward
      // side effects from earlier messages (assistant back-fills user
      // agent/model). For pure per-message equivalence, compare only the
      // entry that the full normalize attributed to *this* message.
      const fullMessage = full.messages.find((x) => x.id === m.id)
      if (fullMessage) {
        const oneMessage = one.messages.find((x) => x.id === m.id)
        expect(oneMessage).toBeDefined()
        // Drop the parent's user-side agent/model back-fill (applied by
        // the full normalize after the assistant was projected); the
        // per-message version does not duplicate it. Compare other fields.
        if (fullMessage.role === "user") {
          expect({ ...oneMessage!, agent: undefined, model: undefined }).toMatchObject({
            ...fullMessage,
            agent: undefined,
            model: undefined,
          })
        } else {
          expect(oneMessage).toMatchObject(fullMessage)
        }
      }
      const fullParts = full.parts.get(m.id)
      if (fullParts && fullParts.length > 0) {
        expect(one.parts.get(m.id)).toEqual(fullParts)
      } else if (fullParts && fullParts.length === 0) {
        expect(one.parts.get(m.id) ?? []).toEqual([])
      }
    }
  })

  test("contextForMessageAt matches the running state of normalizeSessionMessages", () => {
    const source: SessionMessageInfo[] = [
      { id: "a", type: "agent-switched", agent: "build", time: { created: 1 } } as never,
      { id: "m", type: "model-switched", model: { id: "m", providerID: "p" }, time: { created: 2 } } as never,
      { id: "u", type: "user", text: "hi", time: { created: 3 } } as never,
      { id: "as", type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 4 }, content: [] } as never,
    ] as never

    // Equivalent to walking normalizeSessionMessages and capturing the
    // (parent, agent, model) at each message's projection point.
    const expected: NormalizeContext[] = source.map((_, i) => {
      let agent = ""
      let model: { id: string; providerID: string; variant?: string } = { id: "", providerID: "" }
      let parentID: string | undefined
      for (let j = 0; j < i; j++) {
        const m = source[j]!
        if (m.type === "agent-switched") agent = (m as { agent: string }).agent
        else if (m.type === "model-switched") model = (m as { model: { id: string; providerID: string; variant?: string } }).model
        else if (m.type === "user" || (m.type === "synthetic" && (m as { description?: string }).description?.trim())) parentID = m.id
        else if (m.type === "shell") parentID = undefined
        else if (m.type === "assistant") {
          agent = m.agent
          model = m.model
        }
      }
      return { parentID, agent, model }
    })

    for (let i = 0; i < source.length; i++) {
      expect(contextForMessageAt(source, i)).toEqual(expected[i])
    }
  })
})
