import DOMPurify from "dompurify"
import { desktopAllowedUriRegexp, isDesktopRenderer } from "./markdown-desktop"

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

// Mermaid 11 emits a <style> element inside its SVG holding node fills and
// text colors. Stripping it yields black-on-black rendering, so this config
// keeps style tags (DOMPurify still sanitizes their CSS content) while script
// stays forbidden.
export const mermaidConfig = {
  ...config,
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: [...config.ADD_TAGS, "style"],
  FORBID_TAGS: ["script"],
  FORBID_CONTENTS: ["script"],
}

export function sanitizeMermaidSvg(html: string) {
  if (!DOMPurify.isSupported) return ""
  if (isDesktopRenderer()) {
    return DOMPurify.sanitize(html, { ...mermaidConfig, ALLOWED_URI_REGEXP: desktopAllowedUriRegexp })
  }
  return DOMPurify.sanitize(html, mermaidConfig)
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
