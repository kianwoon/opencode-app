import { marked } from "marked"
import DOMPurify from "dompurify"
import { codeToHtml } from "shiki"
import markedShiki from "marked-shiki"
import { createOverflow, useShareMessages } from "./common"
import { CopyButton } from "./copy-button"
import { createResource, createSignal, onMount } from "solid-js"
import style from "./content-markdown.module.css"

let mermaidPromise: Promise<typeof import("mermaid")["default"]> | undefined

// Matches the session-ui markdown-cache sanitize config so mermaid SVGs render
// while style/script and unknown attributes stay stripped.
const mermaidSanitizeConfig = {
  USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style", "script"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path", "g", "rect", "circle", "ellipse", "line", "polygon", "polyline", "text", "tspan", "marker", "defs", "foreignObject", "use", "symbol", "title", "desc", "clipPath", "pattern", "image", "lineargradient", "radialgradient", "stop", "switch", "flowshape"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "transform", "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "opacity", "fill-opacity", "stroke-opacity", "class", "id", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "points", "marker-end", "marker-start", "marker-mid", "refX", "refY", "markerWidth", "markerHeight", "orient", "offset", "stop-color", "stop-opacity", "gradientUnits", "patternUnits", "text-anchor", "dominant-baseline", "font-family", "font-size", "font-weight", "font-style", "text-decoration", "white-space", "aria-roledescription", "role"],
}

function sanitizeMermaidSvg(svg: string) {
  const clean = DOMPurify.sanitize(svg, mermaidSanitizeConfig)
  if (!clean.includes("<svg")) throw new Error("mermaid svg rejected by sanitizer")
  return clean
}

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((module) => {
      module.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: document.documentElement.classList.contains("dark") ? "dark" : "base",
      })
      return module.default
    })
  }
  return mermaidPromise
}

const markedWithShiki = marked.use(
  {
    renderer: {
      link({ href, title, text }) {
        const titleAttr = title ? ` title="${title}"` : ""
        return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
      },
    },
  },
  // Bypass shiki for mermaid: shiki output has no language class, so the
  // scanner below would never match. markedShiki uses the highlight result as
  // the raw html for the block.
  markedShiki({
    highlight(code, lang) {
      if (lang?.trim().toLowerCase() === "mermaid") return escapeMermaid(code)
      return codeToHtml(code, {
        lang: lang || "text",
        themes: {
          light: "github-light",
          dark: "github-dark",
        },
      })
    },
  }),
)

function escapeMermaid(code: string) {
  const escaped = code
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
  return `<pre data-language="mermaid"><code class="language-mermaid">${escaped}</code></pre>`
}

interface Props {
  text: string
  expand?: boolean
  highlight?: boolean
}
export function ContentMarkdown(props: Props) {
  const [html] = createResource(
    () => strip(props.text),
    async (markdown) => {
      return markedWithShiki.parse(markdown)
    },
  )
  const [expanded, setExpanded] = createSignal(false)
  const overflow = createOverflow()
  const messages = useShareMessages()
  let container: HTMLDivElement | undefined

  onMount(() => {
    if (!container) return
    const blocks = Array.from(container.querySelectorAll('pre > code.language-mermaid'))
    if (blocks.length === 0) return
    Promise.all(
      blocks.map(async (code, index) => {
        if (!(code.parentElement instanceof HTMLElement)) return
        const source = code.textContent ?? ""
        const host = document.createElement("div")
        host.setAttribute("data-component", "markdown-mermaid")
        try {
          const mermaid = await loadMermaid()
          const { svg } = await mermaid.render(`mermaid-share-${index}`, source)
          host.innerHTML = sanitizeMermaidSvg(svg)
        } catch {
          // Render failed: keep the raw code block in place.
          return
        }
        code.parentElement.replaceWith(host)
      }),
    )
  })

  return (
    <div
      class={style.root}
      data-highlight={props.highlight === true ? true : undefined}
      data-expanded={expanded() || props.expand === true ? true : undefined}
    >
      <div data-slot="markdown" ref={(el) => {
        overflow.ref(el)
        container = el
      }} innerHTML={html()} />

      {!props.expand && overflow.status && (
        <button
          type="button"
          data-component="text-button"
          data-slot="expand-button"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded() ? messages.show_less : messages.show_more}
        </button>
      )}
      <CopyButton text={props.text} />
    </div>
  )
}

function strip(text: string): string {
  const wrappedRe = /^\s*<([A-Za-z]\w*)>\s*([\s\S]*?)\s*<\/\1>\s*$/
  const match = text.match(wrappedRe)
  return match ? match[2] : text
}
