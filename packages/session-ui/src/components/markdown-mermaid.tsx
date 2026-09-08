import { checksum } from "@opencode-ai/core/util/encode"
import { createResource, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { sanitizeMermaidSvg } from "./markdown-sanitize"

type Mermaid = typeof import("mermaid")["default"]

let promise: Promise<Mermaid> | undefined
let theme: string | undefined

const darkThemeVariables = {
  background: "transparent",
  primaryColor: "#30363d",
  primaryTextColor: "#e6edf3",
  secondaryColor: "#21262d",
  secondaryTextColor: "#e6edf3",
  tertiaryColor: "#161b22",
  tertiaryTextColor: "#e6edf3",
  lineColor: "#8b949e",
  textColor: "#e6edf3",
  mainBkg: "#21262d",
  nodeBorder: "#8b949e",
  fontFamily: "inherit",
}

const baseThemeVariables = {
  background: "transparent",
  primaryColor: "#f6f8fa",
  primaryTextColor: "#1f2328",
  secondaryColor: "#ffffff",
  secondaryTextColor: "#1f2328",
  tertiaryColor: "#f6f8fa",
  tertiaryTextColor: "#1f2328",
  lineColor: "#57606a",
  textColor: "#1f2328",
  mainBkg: "#ffffff",
  nodeBorder: "#57606a",
  fontFamily: "inherit",
}

const themeCSS = {
  dark: `.node text,.label,.cluster-label{fill:#e6edf3 !important;font-family:inherit !important} .edgeLabel{fill:#8b949e !important}`,
  base: `.node text,.label,.cluster-label{fill:#1f2328 !important;font-family:inherit !important} .edgeLabel{fill:#57606a !important}`,
}

function load(themeName: "dark" | "base") {
  if (promise && theme === themeName) return promise
  theme = themeName
  promise = import("mermaid").then((module) => {
    module.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: themeName,
      themeVariables: themeName === "dark" ? darkThemeVariables : baseThemeVariables,
      themeCSS: themeCSS[themeName],
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

// Mermaid passes the id to document.querySelector('#'+id) internally, so it
// must only contain querySelector-safe characters. Collapse repeats and append
// a checksum suffix to preserve uniqueness after sanitization.
export function mermaidId(raw: string) {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-")
  const prefixed = /^[A-Za-z]/.test(cleaned) ? cleaned : `m-${cleaned}`
  return `${prefixed}-${checksum(raw)}`
}

export async function renderMermaidSvg(id: string, code: string, themeName: "dark" | "base") {
  const cacheKey = `${themeName}:${checksum(code)}`
  const cached = cache.get(cacheKey)
  if (cached) return cached
  const mermaid = await load(themeName)
  const { svg } = await mermaid.render(mermaidId(id), code)
  const safe = sanitizeMermaidSvg(svg)
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
      <Show when={svg()}>
        {(value) => (
          <div
            data-slot="markdown-mermaid-svg"
            innerHTML={value()}
            ref={(el) => {
              const svgEl = el.querySelector("svg")
              if (svgEl && !svgEl.getAttribute("background")) svgEl.setAttribute("background", "transparent")
            }}
          />
        )}
      </Show>
    </>
  )
}
