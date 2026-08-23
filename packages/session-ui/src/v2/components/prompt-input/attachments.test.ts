import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptInputV2Attachments } from "./attachments"
import type { PromptInputV2Prompt } from "./types"

// The attachments module registers document drag listeners on mount; bun test
// runs without a DOM, so provide a minimal stub when none exists.
globalThis.document ??= {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
} as unknown as Document

function harness(readClipboardImage?: () => Promise<File | null>) {
  let warned = 0
  const prompt: PromptInputV2Prompt = []
  const attachments = createRoot((dispose) => {
    const created = createPromptInputV2Attachments({
      directory: () => "/tmp/project",
      isDialogActive: () => false,
      warn: () => {
        warned += 1
      },
      duplicate: () => undefined,
      onError: () => undefined,
      readClipboardImage,
      store: async (file) => ({ id: `blob:${file.size}`, url: "blob:url" }),
      capture: () => ({
        current: () => prompt,
        cursor: () => 0,
        set: (parts: PromptInputV2Prompt) => {
          prompt.length = 0
          prompt.push(...parts)
        },
      }),
      editor: () => ({}) as HTMLElement,
      focusEditor: () => undefined,
      addPart: () => true,
      setDraggingType: () => undefined,
    })
    dispose()
    return created
  })
  return { attachments, prompt, warnings: () => warned }
}

function pasteEvent(files: File[]) {
  return {
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    clipboardData: {
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: () => "",
    },
  } as unknown as ClipboardEvent
}

describe("prompt input v2 paste fallbacks", () => {
  test("attaches accepted clipboard images without touching the native clipboard", async () => {
    let nativeReads = 0
    const { attachments, prompt, warnings } = harness(async () => {
      nativeReads += 1
      return null
    })
    await attachments.handlePaste(pasteEvent([new File([Uint8Array.of(1, 2, 3)], "shot.png", { type: "image/png" })]))
    expect(nativeReads).toBe(0)
    expect(prompt.length).toBe(1)
    expect(warnings()).toBe(0)
  })

  test("retries rejected clipboard images through the native PNG reader", async () => {
    // macOS surfaces copied images as image/tiff in clipboardData, which no provider accepts.
    const tiff = new File([Uint8Array.of(0, 255, 1, 2)], "pasted-image-1.tiff", { type: "image/tiff" })
    const png = new File([Uint8Array.of(1, 2, 3)], "pasted-image-1.png", { type: "image/png" })
    const { attachments, prompt, warnings } = harness(async () => png)
    await attachments.handlePaste(pasteEvent([tiff]))
    expect(prompt.length).toBe(1)
    expect((prompt[0] as { mime: string }).mime).toBe("image/png")
    expect(warnings()).toBe(0)
  })

  test("warns when rejected clipboard images have no native fallback", async () => {
    const tiff = new File([Uint8Array.of(0, 255, 1, 2)], "pasted-image-1.tiff", { type: "image/tiff" })
    const { attachments, prompt, warnings } = harness()
    await attachments.handlePaste(pasteEvent([tiff]))
    expect(prompt.length).toBe(0)
    expect(warnings()).toBe(1)
  })
})
