import { checksum } from "@opencode-ai/core/util/encode"
import { createResource, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { sanitizeMarkdown } from "./markdown-cache"

type Mermaid = typeof import("mermaid")["default"]

let promise: Promise<Mermaid> | undefined
let theme: string | undefined

function load(themeName: "dark" | "base") {
  if (promise && theme === themeName) return promise
  theme = themeName
  promise = import("mermaid").then((module) => {
    module.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: themeName,
    })
    return module.default
  })
  return promise
}

const maxCache = 50
const cache = new Map<string, string>()

function remember(key: string, svg: string) {
  cache.delete(key)
  cache.set(key, svg)
  if (cache.size <= maxCache) return
  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

export async function renderMermaidSvg(id: string, code: string, themeName: "dark" | "base") {
  const cacheKey = `${themeName}:${checksum(code)}`
  const cached = cache.get(cacheKey)
  if (cached) return cached
  const mermaid = await load(themeName)
  const { svg } = await mermaid.render(id, code)
  const safe = sanitizeMarkdown(svg)
  if (safe) remember(cacheKey, safe)
  return safe
}

function darkTheme(): "dark" | "base" {
  const scheme = document.documentElement.getAttribute("data-color-scheme") ?? document.body.getAttribute("data-color-scheme")
  return scheme === "light" ? "base" : "dark"
}

export function MermaidIsland(props: { code: string; id: string }) {
  const i18n = useI18n()
  const [svg] = createResource(
    () => ({ code: props.code, theme: darkTheme() }),
    (source) => renderMermaidSvg(props.id, source.code, source.theme),
  )
  return (
    <>
      <Show when={svg.error}>
        <div data-slot="markdown-mermaid-status" data-status="error" role="alert">
          {String(i18n.t("ui.markdown.mermaidError"))}
        </div>
      </Show>
      <Show when={svg()}>{(value) => <div data-slot="markdown-mermaid-svg" innerHTML={value()} />}</Show>
    </>
  )
}
