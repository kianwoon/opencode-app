export * as FolderDrop from "./folder-drop"

import { createSignal, getOwner, onCleanup } from "solid-js"

type DropItem = {
  readonly kind: string
  readonly type: string
  getAsFile(): File | null
  webkitGetAsEntry?(): { readonly isDirectory: boolean } | null
}

type DropDataTransfer = {
  readonly types: ArrayLike<string>
  readonly items?: ArrayLike<DropItem>
}

type DropEvent = {
  readonly dataTransfer?: DropDataTransfer | null
}

export type FolderDropResolver = {
  /** Resolves the native filesystem path for a dropped desktop File, when available. */
  readonly getPathForFile?: (file: File) => string | undefined
  /** Invoked with every accepted directory, in drop order. */
  readonly onAddProjects: (directories: string[]) => void
  /** Reported when a drop carries files but none of them resolve to folders. */
  readonly onNotFolders?: () => void
}

/** True when a drag carries OS files (as opposed to an in-app sortable drag). */
export function hasFileDrag(event: DropEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files")
}

/**
 * Extracts absolute directory paths from a drop event.
 *
 * Directory detection uses the entries API (`webkitGetAsEntry`), the only
 * reliable signal in Electron renderers; extension-less files and folders both
 * report an empty MIME type, so MIME sniffing cannot distinguish them. Absolute
 * paths come from `getPathForFile` (Electron `webUtils`); without it (plain
 * web) paths cannot be resolved and the drop yields nothing.
 */
export function droppedDirectories(event: DropEvent, getPathForFile?: (file: File) => string | undefined) {
  const directories: string[] = []
  let candidates = 0
  for (const item of Array.from(event.dataTransfer?.items ?? [])) {
    if (item.kind !== "file") continue
    const file = item.getAsFile()
    if (!file) continue
    const path = getPathForFile?.(file)
    if (!path) continue
    candidates++
    if (!item.webkitGetAsEntry?.()?.isDirectory) continue
    directories.push(path)
  }
  return { directories, candidates }
}

/**
 * Folder drop-zone controller. Tracks dragenter/dragleave depth so the active
 * highlight stays stable while the pointer crosses child elements, and exposes
 * `active()` as a reactive signal for styling the zone. Without a path
 * resolver the zone stays inert: drag events are never accepted.
 */
export function makeFolderDrop(resolver: FolderDropResolver) {
  const [active, setActive] = createSignal(false)
  const enabled = () => resolver.getPathForFile !== undefined
  let depth = 0

  // A drag that ends outside this zone (dropped elsewhere, ESC-cancelled, or
  // dragged out of the window from a nested child) never balances the enter
  // depth with zone-level leaves, so reset on the document-level terminators.
  if (getOwner()) {
    const reset = () => {
      depth = 0
      setActive(false)
    }
    document.addEventListener("drop", reset, true)
    document.addEventListener("dragend", reset, true)
    onCleanup(() => {
      document.removeEventListener("drop", reset, true)
      document.removeEventListener("dragend", reset, true)
    })
  }

  const dragOver = (event: DragEvent) => {
    if (!enabled() || !hasFileDrag(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
  }

  const dragEnter = (event: DragEvent) => {
    if (!enabled() || !hasFileDrag(event)) return
    event.preventDefault()
    depth++
    setActive(true)
  }

  const dragLeave = (event: DragEvent) => {
    if (depth === 0) return
    // Stop the drag at the zone boundary: the composer installs a document-level
    // drop handler that attaches dropped files to the prompt input.
    event.stopPropagation()
    if (--depth === 0) setActive(false)
  }

  const drop = (event: DragEvent) => {
    depth = 0
    setActive(false)
    if (!enabled() || !hasFileDrag(event)) return
    // Consume the drop at the zone: prevents the browser's default navigation
    // and the composer's document-level attachment handler.
    event.preventDefault()
    event.stopPropagation()
    const { directories, candidates } = droppedDirectories(event, resolver.getPathForFile)
    if (directories.length === 0) {
      if (candidates > 0) resolver.onNotFolders?.()
      return
    }
    resolver.onAddProjects(directories)
  }

  return { active, enabled, dragOver, dragEnter, dragLeave, drop }
}
