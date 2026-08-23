import { describe, expect, test } from "bun:test"
import { type ContentPart } from "@/context/prompt"
import { createPromptAttachmentsCore } from "./attachments"
import { attachmentMime, pickAttachmentFiles } from "./files"
import { pasteMode } from "./paste"

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })
})

describe("pickAttachmentFiles", () => {
  test("reads the current project directory for every native picker invocation", async () => {
    const paths: string[] = []
    const files: File[] = []
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    let directory = "C:\\Projects\\LoremIpsum"
    const picker = async (options?: { defaultPath?: string }, onFile?: (file: File) => Promise<unknown>) => {
      paths.push(options?.defaultPath ?? "")
      await onFile?.(file)
    }

    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    directory = "C:\\Projects\\DolorSit"
    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    expect(files).toEqual([file, file])
    expect(paths).toEqual(["C:\\Projects\\LoremIpsum", "C:\\Projects\\DolorSit"])
  })

  test("uses the browser file input when no native picker exists", async () => {
    let fallback = 0
    pickAttachmentFiles({
      directory: () => "/projects/consectetur-adipiscing",
      fallback: () => {
        fallback += 1
      },
      onFile: async () => undefined,
      onError: () => undefined,
    })
    expect(fallback).toBe(1)
  })

  test("reports native picker failures without rejecting", async () => {
    const error = new Error("picker unavailable")
    const errors: unknown[] = []
    const handled = Promise.withResolvers<void>()
    pickAttachmentFiles({
      picker: async () => Promise.reject(error),
      directory: () => "C:\\Projects\\LoremIpsum",
      fallback: () => undefined,
      onFile: async () => undefined,
      onError: (cause) => {
        errors.push(cause)
        handled.resolve()
      },
    })
    await handled.promise
    expect(errors).toEqual([error])
  })
})

describe("paste fallbacks", () => {
  const draftStore = {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    putBlob: async (blob: Blob) => ({ id: `blob:${blob.size}`, url: "blob:url" }),
  }

  function harness(readClipboardImage?: () => Promise<File | null>) {
    let warned = 0
    const attachments: ContentPart[] = []
    const core = createPromptAttachmentsCore({
      capture: () => ({
        current: () => attachments,
        cursor: () => 0,
        set: (parts: ContentPart[]) => {
          attachments.length = 0
          attachments.push(...parts)
        },
      }),
      editor: () => ({}) as HTMLDivElement,
      warn: () => {
        warned += 1
      },
      readClipboardImage,
      draftStore,
    })
    return { core, attachments, warnings: () => warned }
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

  test("attaches accepted clipboard images without touching the native clipboard", async () => {
    let nativeReads = 0
    const { core, attachments, warnings } = harness(async () => {
      nativeReads += 1
      return null
    })
    await core.handlePaste(pasteEvent([new File([Uint8Array.of(1, 2, 3)], "shot.png", { type: "image/png" })]))
    expect(nativeReads).toBe(0)
    expect(attachments.length).toBe(1)
    expect(warnings()).toBe(0)
  })

  test("retries rejected clipboard images through the native PNG reader", async () => {
    // macOS surfaces copied images as image/tiff in clipboardData, which no provider accepts.
    const tiff = new File([Uint8Array.of(0, 255, 1, 2)], "pasted-image-1.tiff", { type: "image/tiff" })
    const png = new File([Uint8Array.of(1, 2, 3)], "pasted-image-1.png", { type: "image/png" })
    const { core, attachments, warnings } = harness(async () => png)
    await core.handlePaste(pasteEvent([tiff]))
    expect(attachments.length).toBe(1)
    expect((attachments[0] as { mime: string }).mime).toBe("image/png")
    expect(warnings()).toBe(0)
  })

  test("warns when rejected clipboard images have no native fallback", async () => {
    const tiff = new File([Uint8Array.of(0, 255, 1, 2)], "pasted-image-1.tiff", { type: "image/tiff" })
    const { core, attachments, warnings } = harness()
    await core.handlePaste(pasteEvent([tiff]))
    expect(attachments.length).toBe(0)
    expect(warnings()).toBe(1)
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})
