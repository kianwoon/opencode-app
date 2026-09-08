import { checksum } from "@opencode-ai/core/util/encode"
import DOMPurify from "dompurify"
import { desktopAllowedUriRegexp, isDesktopRenderer } from "./markdown-desktop"
import { project } from "./markdown-stream"
import { parseMarkdown } from "./markdown-worker"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, MarkdownCacheEntry>()
const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path", "g", "rect", "circle", "ellipse", "line", "polygon", "polyline", "text", "tspan", "marker", "defs", "foreignObject", "use", "symbol", "title", "desc", "clipPath", "pattern", "image", "lineargradient", "radialgradient", "stop", "switch", "flowshape", "span", "div", "p", "br"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target", "transform", "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "opacity", "fill-opacity", "stroke-opacity", "class", "id", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "points", "marker-end", "marker-start", "marker-mid", "refX", "refY", "markerWidth", "markerHeight", "orient", "offset", "stop-color", "stop-opacity", "gradientUnits", "patternUnits", "text-anchor", "dominant-baseline", "font-family", "font-size", "font-weight", "font-style", "text-decoration", "white-space", "aria-roledescription", "role", "colspan", "rowspan", "style"],
}

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

export function sanitizeMarkdown(html: string) {
  if (!DOMPurify.isSupported) return ""
  // Desktop: keep file: hrefs so chat path links stay clickable. Web keeps the
  // default scheme allowlist (browsers block file: navigation anyway).
  if (isDesktopRenderer()) {
    return DOMPurify.sanitize(html, { ...config, ALLOWED_URI_REGEXP: desktopAllowedUriRegexp })
  }
  return DOMPurify.sanitize(html, config)
}

export function getCachedMarkdown(key: string) {
  return cache.get(key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

export async function preloadMarkdown(
  text: string,
  cacheKey: string,
  parser: { parse(text: string): string | Promise<string> },
) {
  await Promise.all(
    project(undefined, text, false).blocks.map(async (block, index) => {
      if (block.mode === "code") return
      const key = `${cacheKey}:${index}:${block.mode}`
      const cached = getCachedMarkdown(key)
      if (cached?.raw === block.raw) {
        touchCachedMarkdown(key, cached)
        return
      }
      const hash = checksum(block.raw)
      if (!hash) return
      touchCachedMarkdown(key, {
        raw: block.raw,
        hash,
        html: sanitizeMarkdown(await Promise.resolve(parser.parse(block.src))),
      })
    }),
  )
}

export async function preloadMarkdownWithWorker(text: string, cacheKey: string) {
  await Promise.all(
    project(undefined, text, false).blocks.map(async (block, index) => {
      if (block.mode === "code") return
      const key = `${cacheKey}:${index}:${block.mode}`
      const cached = getCachedMarkdown(key)
      if (cached?.raw === block.raw) {
        touchCachedMarkdown(key, cached)
        return
      }
      const hash = checksum(block.raw)
      if (!hash) return
      touchCachedMarkdown(key, {
        raw: block.raw,
        hash,
        html: sanitizeMarkdown(await parseMarkdown(block.src)),
      })
    }),
  )
}
