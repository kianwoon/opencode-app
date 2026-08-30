import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState, DEFAULT_PROMPT, isPromptEqual } from "./prompt-state"

describe("prompt state initialization", () => {
  test("initializes prompt text, cursor, and model together", () => {
    createRoot((dispose) => {
      const model = { providerID: "anthropic", modelID: "claude", variant: "high" }
      const prompt = createPromptState({ prompt: "hello", model })

      expect(prompt.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
      expect(prompt.cursor()).toBe(5)
      expect(prompt.model.current()).toEqual(model)
      expect(prompt.model.current()).not.toBe(model)
      dispose()
    })
  })

  test("uses the default prompt without initial values", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()

      expect(prompt.current()).toEqual(DEFAULT_PROMPT)
      expect(prompt.cursor()).toBeUndefined()
      expect(prompt.model.current()).toBeUndefined()
      dispose()
    })
  })
})

describe("isPromptEqual", () => {
  test("empty prompts are equal", () => {
    expect(isPromptEqual(DEFAULT_PROMPT, DEFAULT_PROMPT)).toBe(true)
  })

  test("identical text prompts are equal", () => {
    const a = [{ type: "text" as const, content: "hello", start: 0, end: 5 }]
    const b = [{ type: "text" as const, content: "hello", start: 0, end: 5 }]
    expect(isPromptEqual(a, b)).toBe(true)
  })

  test("identical text prompts with different start/end are still equal (content match)", () => {
    const a = [{ type: "text" as const, content: "hello", start: 0, end: 5 }]
    const b = [{ type: "text" as const, content: "hello", start: 10, end: 15 }]
    expect(isPromptEqual(a, b)).toBe(true)
  })

  test("different text prompts are not equal", () => {
    const a = [{ type: "text" as const, content: "hello", start: 0, end: 5 }]
    const b = [{ type: "text" as const, content: "world", start: 0, end: 5 }]
    expect(isPromptEqual(a, b)).toBe(false)
  })

  test("differing lengths are not equal", () => {
    const a = [{ type: "text" as const, content: "hello", start: 0, end: 5 }]
    const b = [
      { type: "text" as const, content: "hello", start: 0, end: 5 },
      { type: "text" as const, content: "world", start: 6, end: 11 },
    ]
    expect(isPromptEqual(a, b)).toBe(false)
  })

  test("type mismatch between text and file is not equal", () => {
    const a = [{ type: "text" as const, content: "hello", start: 0, end: 5 }]
    const b = [{ type: "file" as const, content: "", path: "hello", start: 0, end: 0 }]
    expect(isPromptEqual(a, b)).toBe(false)
  })

  test("identical file parts are equal", () => {
    const a = [
      {
        type: "file" as const,
        content: "",
        path: "/src/index.ts",
        mime: "text/typescript",
        filename: "index.ts",
        start: 0,
        end: 0,
      },
    ]
    const b = [
      {
        type: "file" as const,
        content: "",
        path: "/src/index.ts",
        mime: "text/typescript",
        filename: "index.ts",
        start: 0,
        end: 0,
      },
    ]
    expect(isPromptEqual(a, b)).toBe(true)
  })

  test("file parts with different paths are not equal", () => {
    const a = [{ type: "file" as const, content: "", path: "/a.ts", start: 0, end: 0 }]
    const b = [{ type: "file" as const, content: "", path: "/b.ts", start: 0, end: 0 }]
    expect(isPromptEqual(a, b)).toBe(false)
  })

  test("file parts with different selections are not equal", () => {
    const a = [
      {
        type: "file" as const,
        content: "",
        path: "/a.ts",
        selection: { startLine: 1, startChar: 0, endLine: 10, endChar: 0 },
        start: 0,
        end: 0,
      },
    ]
    const b = [
      {
        type: "file" as const,
        content: "",
        path: "/a.ts",
        selection: { startLine: 1, startChar: 0, endLine: 20, endChar: 0 },
        start: 0,
        end: 0,
      },
    ]
    expect(isPromptEqual(a, b)).toBe(false)
  })

  test("file parts with same selection are equal", () => {
    const a = [
      {
        type: "file" as const,
        content: "",
        path: "/a.ts",
        selection: { startLine: 1, startChar: 0, endLine: 10, endChar: 0 },
        start: 0,
        end: 0,
      },
    ]
    const b = [
      {
        type: "file" as const,
        content: "",
        path: "/a.ts",
        selection: { startLine: 1, startChar: 0, endLine: 10, endChar: 0 },
        start: 0,
        end: 0,
      },
    ]
    expect(isPromptEqual(a, b)).toBe(true)
  })

  test("null/undefined selections are equal", () => {
    const a = [{ type: "file" as const, content: "", path: "/a.ts", selection: undefined, start: 0, end: 0 }]
    const b = [{ type: "file" as const, content: "", path: "/a.ts", start: 0, end: 0 }]
    expect(isPromptEqual(a, b)).toBe(true)
  })

  test("one with selection and one without are not equal", () => {
    const a = [
      {
        type: "file" as const,
        content: "",
        path: "/a.ts",
        selection: { startLine: 1, startChar: 0, endLine: 10, endChar: 0 },
        start: 0,
        end: 0,
      },
    ]
    const b = [{ type: "file" as const, content: "", path: "/a.ts", start: 0, end: 0 }]
    expect(isPromptEqual(a, b)).toBe(false)
  })

  test("identical agent parts are equal", () => {
    const a = [{ type: "agent" as const, name: "build", content: "", start: 0, end: 0 }]
    const b = [{ type: "agent" as const, name: "build", content: "", start: 0, end: 0 }]
    expect(isPromptEqual(a, b)).toBe(true)
  })

  test("different agent names are not equal", () => {
    const a = [{ type: "agent" as const, name: "build", content: "", start: 0, end: 0 }]
    const b = [{ type: "agent" as const, name: "plan", content: "", start: 0, end: 0 }]
    expect(isPromptEqual(a, b)).toBe(false)
  })

  test("identical image parts are equal", () => {
    const a = [{ type: "image" as const, id: "img-1", filename: "screenshot.png", mime: "image/png", blob: {} as any }]
    const b = [{ type: "image" as const, id: "img-1", filename: "screenshot.png", mime: "image/png", blob: {} as any }]
    expect(isPromptEqual(a, b)).toBe(true)
  })

  test("different image ids are not equal", () => {
    const a = [{ type: "image" as const, id: "img-1", filename: "screenshot.png", mime: "image/png", blob: {} as any }]
    const b = [{ type: "image" as const, id: "img-2", filename: "screenshot.png", mime: "image/png", blob: {} as any }]
    expect(isPromptEqual(a, b)).toBe(false)
  })

  test("mixed content with different structure is not equal", () => {
    const a = [
      { type: "text" as const, content: "hello", start: 0, end: 5 },
      { type: "text" as const, content: "world", start: 6, end: 11 },
    ]
    const b = [
      { type: "text" as const, content: "hello", start: 0, end: 5 },
      { type: "file" as const, content: "", path: "/world.ts", start: 0, end: 0 },
    ]
    expect(isPromptEqual(a, b)).toBe(false)
  })
})

describe("dirty", () => {
  test("dirty returns false for default empty prompt", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()
      expect(prompt.dirty()).toBe(false)
      dispose()
    })
  })

  test("dirty returns true for non-empty text prompt", () => {
    createRoot((dispose) => {
      const prompt = createPromptState({ prompt: "hi" })
      expect(prompt.dirty()).toBe(true)
      dispose()
    })
  })

  test("dirty returns false after reset of a dirty prompt", () => {
    createRoot((dispose) => {
      const prompt = createPromptState({ prompt: "some text" })
      expect(prompt.dirty()).toBe(true)
      prompt.reset()
      expect(prompt.dirty()).toBe(false)
      expect(prompt.current()).toEqual(DEFAULT_PROMPT)
      dispose()
    })
  })

  test("dirty becomes false when prompt is set to empty default", () => {
    createRoot((dispose) => {
      const prompt = createPromptState({ prompt: "initial" })
      expect(prompt.dirty()).toBe(true)
      prompt.set(DEFAULT_PROMPT)
      expect(prompt.dirty()).toBe(false)
      dispose()
    })
  })

  test("dirty stays true when prompt content changes but remains non-default", () => {
    createRoot((dispose) => {
      const prompt = createPromptState({ prompt: "initial" })
      expect(prompt.dirty()).toBe(true)
      prompt.set([{ type: "text", content: "updated", start: 0, end: 7 }])
      expect(prompt.dirty()).toBe(true)
      dispose()
    })
  })

  test("dirty is reactive — changes with set calls", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()
      expect(prompt.dirty()).toBe(false)

      prompt.set([{ type: "text", content: "x", start: 0, end: 1 }])
      expect(prompt.dirty()).toBe(true)

      prompt.reset()
      expect(prompt.dirty()).toBe(false)
      dispose()
    })
  })

  test("dirty returns true for a file attachment in prompt", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()
      prompt.set([
        {
          type: "file",
          content: "",
          path: "/src/app.ts",
          mime: "text/typescript",
          filename: "app.ts",
          start: 0,
          end: 0,
        },
      ])
      expect(prompt.dirty()).toBe(true)
      dispose()
    })
  })

  test("dirty returns true for an agent part in prompt", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()
      prompt.set([{ type: "agent", name: "build", content: "", start: 0, end: 0 }])
      expect(prompt.dirty()).toBe(true)
      dispose()
    })
  })

  test("dirty returns true for whitespace-only text prompt (non-empty content)", () => {
    createRoot((dispose) => {
      const prompt = createPromptState({ prompt: "  " })
      expect(prompt.dirty()).toBe(true)
      dispose()
    })
  })

  test("dirty returns false when set to a single empty text part (same as default)", () => {
    createRoot((dispose) => {
      const prompt = createPromptState({ prompt: "was dirty" })
      expect(prompt.dirty()).toBe(true)
      prompt.set([{ type: "text", content: "", start: 0, end: 0 }])
      expect(prompt.dirty()).toBe(false)
      dispose()
    })
  })

  test("dirty depends on prompt content, not model", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()
      expect(prompt.dirty()).toBe(false)
      prompt.model.set({ providerID: "anthropic", modelID: "claude" })
      expect(prompt.dirty()).toBe(false)
      dispose()
    })
  })
})
