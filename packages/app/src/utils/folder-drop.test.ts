import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { droppedDirectories, hasFileDrag, makeFolderDrop } from "./folder-drop"

function fakeFile(args: { type?: string; path?: string } = {}) {
  const file = new File([""], "name", { type: args.type ?? "" })
  return { file, path: args.path }
}

function dropEvent(
  items: Array<{ kind: string; entry?: { isDirectory: boolean } | null; file?: ReturnType<typeof fakeFile> }>,
) {
  return {
    preventDefault: () => {},
    stopPropagation: () => {},
    dataTransfer: {
      types: items.some((item) => item.kind === "file") ? ["Files"] : ["other"],
      items: items.map((item) => ({
        kind: item.kind,
        type: "",
        getAsFile: () => item.file?.file ?? null,
        webkitGetAsEntry: () => item.entry ?? null,
      })),
    },
  }
}

describe("hasFileDrag", () => {
  test("detects file drags", () => {
    expect(hasFileDrag(dropEvent([{ kind: "file" }]))).toBe(true)
  })

  test("ignores non-file drags like in-app sortables", () => {
    expect(hasFileDrag(dropEvent([{ kind: "string" }]))).toBe(false)
    expect(hasFileDrag({ dataTransfer: null })).toBe(false)
  })
})

describe("droppedDirectories", () => {
  test("collects directory entries with resolved paths", () => {
    const a = fakeFile({ path: "/tmp/project-a" })
    const b = fakeFile({ path: "/tmp/.config" })
    const event = dropEvent([
      { kind: "file", entry: { isDirectory: true }, file: a },
      { kind: "file", entry: { isDirectory: true }, file: b },
    ])
    expect(droppedDirectories(event, (file) => (file === a.file ? a.path : b.path))).toEqual({
      directories: ["/tmp/project-a", "/tmp/.config"],
      candidates: 2,
    })
  })

  test("skips plain-file entries", () => {
    const file = fakeFile({ path: "/tmp/notes.txt" })
    const event = dropEvent([{ kind: "file", entry: { isDirectory: false }, file }])
    expect(droppedDirectories(event, () => file.path)).toEqual({ directories: [], candidates: 1 })
  })

  test("yields nothing without a path resolver", () => {
    const folder = fakeFile({ path: "/tmp/folder" })
    const event = dropEvent([{ kind: "file", entry: { isDirectory: true }, file: folder }])
    expect(droppedDirectories(event)).toEqual({ directories: [], candidates: 0 })
  })
})

describe("makeFolderDrop", () => {
  test("drop forwards directories to onAddProjects", () => {
    const added: string[][] = []
    const folder = fakeFile({ path: "/tmp/project" })
    const drop = makeFolderDrop({ getPathForFile: () => folder.path, onAddProjects: (dirs) => added.push(dirs) })
    drop.drop(dropEvent([{ kind: "file", entry: { isDirectory: true }, file: folder }]) as unknown as DragEvent)
    expect(added).toEqual([["/tmp/project"]])
  })

  test("drop reports non-folder drops", () => {
    let notFolders = 0
    const file = fakeFile({ path: "/tmp/a.txt" })
    const drop = makeFolderDrop({
      getPathForFile: () => file.path,
      onAddProjects: () => {},
      onNotFolders: () => {
        notFolders++
      },
    })
    drop.drop(dropEvent([{ kind: "file", entry: { isDirectory: false }, file }]) as unknown as DragEvent)
    expect(notFolders).toBe(1)
  })

  test("zone stays inert without a path resolver", () => {
    const added: string[][] = []
    const drop = makeFolderDrop({ onAddProjects: (dirs) => added.push(dirs) })
    const folder = fakeFile({ path: "/tmp/project" })
    const event = dropEvent([{ kind: "file", entry: { isDirectory: true }, file: folder }])
    drop.dragEnter(event as unknown as DragEvent)
    drop.drop(event as unknown as DragEvent)
    expect(drop.active()).toBe(false)
    expect(added).toEqual([])
  })
})

describe("makeFolderDrop drag depth", () => {
  function zone() {
    const added: string[][] = []
    const folder = fakeFile({ path: "/tmp/project" })
    const event = () => dropEvent([{ kind: "file", entry: { isDirectory: true }, file: folder }])
    const root = createRoot((dispose) => ({
      made: makeFolderDrop({
        getPathForFile: () => folder.path,
        onAddProjects: (dirs) => added.push(dirs),
      }),
      dispose,
    }))
    return { ...root.made, dispose: root.dispose, added, event }
  }

  test("enter and leave pair back to inactive", () => {
    const z = zone()
    z.dragEnter(z.event() as unknown as DragEvent)
    expect(z.active()).toBe(true)
    z.dragLeave(z.event() as unknown as DragEvent)
    expect(z.active()).toBe(false)
  })

  test("nested child enter and single leave keeps overlay active", () => {
    const z = zone()
    z.dragEnter(z.event() as unknown as DragEvent)
    z.dragEnter(z.event() as unknown as DragEvent)
    z.dragLeave(z.event() as unknown as DragEvent)
    expect(z.active()).toBe(true)
  })

  test("document dragend resets residual depth", () => {
    const z = zone()
    z.dragEnter(z.event() as unknown as DragEvent)
    z.dragEnter(z.event() as unknown as DragEvent)
    document.dispatchEvent(new Event("dragend"))
    expect(z.active()).toBe(false)
    // Zone still works after reset.
    z.dragEnter(z.event() as unknown as DragEvent)
    expect(z.active()).toBe(true)
    z.dispose()
  })

  test("document drop resets residual depth", () => {
    const z = zone()
    z.dragEnter(z.event() as unknown as DragEvent)
    document.dispatchEvent(new Event("drop"))
    expect(z.active()).toBe(false)
    z.dispose()
  })
})
