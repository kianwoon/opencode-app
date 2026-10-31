import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { contrastRatio, hexToOklch } from "../color"
import type { DesktopTheme, HexColor, ResolvedV2Theme } from "../types"
import { mapV2Semantics } from "./mapping"
import { resolveThemeVariantV2 } from "./resolve"

/** Canonical v2 declarations, as documented in `styles/tokens/theme.css`. */
const css = (await Bun.file(new URL("../../styles/tokens/theme.css", import.meta.url)).text()).replace(
  /\/\*[\s\S]*?\*\//g,
  "",
)

const declared = {
  light: readDeclarations(css.slice(css.indexOf(":root {"), css.indexOf('[data-color-scheme="light"]'))),
  dark: readDeclarations(css.slice(css.indexOf('[data-color-scheme="dark"]'))),
}

const canonical = [...declared.light.keys()]

/** Derived from theme ink by `foreground.ts`, with contrast guarantees. */
const foreground = (token: string) =>
  /^v2-text-text-(base|muted|faint)$/.test(token) || token.startsWith("v2-icon-icon-")

/** Fixed, theme-independent project avatar colors. */
const fixed = (token: string) => token.startsWith("v2-avatar-")

const theme = (await Bun.file(new URL("../themes/oc-2.json", import.meta.url)).json()) as DesktopTheme
const matrix = (await Bun.file(new URL("../themes/matrix.json", import.meta.url)).json()) as DesktopTheme

const derive = (variant: DesktopTheme["light"], isDark: boolean) =>
  resolveThemeVariantV2({ ...variant, v2Overrides: undefined }, isDark)

describe("canonical token coverage", () => {
  test("both color schemes declare the same token set", () => {
    expect([...declared.dark.keys()].sort()).toEqual([...declared.light.keys()].sort())
    expect(canonical.length).toBeGreaterThanOrEqual(91)
  })

  test("every bundled theme emits every declared v2 token", async () => {
    const files = readdirSync(new URL("../themes", import.meta.url)).filter((file) => file.endsWith(".json"))
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const bundled = (await Bun.file(new URL(`../themes/${file}`, import.meta.url)).json()) as DesktopTheme

      for (const isDark of [false, true]) {
        const tokens = resolveThemeVariantV2(isDark ? bundled.dark : bundled.light, isDark)
        const missing = canonical.filter((token) => !(token in tokens))

        expect({ theme: bundled.id, isDark, missing }).toEqual({ theme: bundled.id, isDark, missing: [] })
      }
    }
  })

  test("the semantic table mirrors every declared non-foreground token", () => {
    for (const isDark of [false, true]) {
      const table = mapV2Semantics(isDark)
      const documented = isDark ? declared.dark : declared.light

      for (const [token, value] of documented) {
        if (foreground(token) || fixed(token)) continue
        expect({ token, isDark, value: table[token] }).toEqual({ token, isDark, value })
      }
    }
  })
})

describe("documented mapping", () => {
  test.each([false, true])("derived tokens follow the documented primitive mapping (dark: %s)", (isDark) => {
    const tokens = derive(isDark ? theme.dark : theme.light, isDark)
    const documented = isDark ? declared.dark : declared.light

    for (const token of ["v2-background-bg-base", "v2-background-bg-accent", "v2-text-text-accent"]) {
      expect({ token, value: tokens[token] }).toEqual({ token, value: documented.get(token)! })
    }

    for (let step = 1; step <= 4; step++) {
      const token = `v2-background-bg-layer-0${step}`
      expect(tokens[token]).toBe(documented.get(token)!)
    }
  })

  test("background, text, and accent tokens differ per color scheme", () => {
    const light = derive(theme.light, false)
    const dark = derive(theme.dark, true)
    const differs = [
      "v2-background-bg-base",
      "v2-background-bg-layer-01",
      "v2-text-text-base",
      "v2-text-text-muted",
      "v2-text-text-faint",
      "v2-text-text-accent",
    ]

    for (const token of differs) expect({ token, same: light[token] === dark[token] }).toEqual({ token, same: false })
    expect(lightness(resolve(light, "v2-background-bg-base"))).toBeGreaterThan(0.9)
    expect(lightness(resolve(dark, "v2-background-bg-base"))).toBeLessThan(0.25)
  })

  test.each([false, true])("text steps dim from base to muted to faint (dark: %s)", (isDark) => {
    const tokens = derive(isDark ? theme.dark : theme.light, isDark)
    const background = resolve(tokens, "v2-background-bg-base")
    const ratio = (token: string) => contrastRatio(resolve(tokens, token), background)

    expect(ratio("v2-text-text-base")).toBeGreaterThan(ratio("v2-text-text-muted"))
    expect(ratio("v2-text-text-muted")).toBeGreaterThan(ratio("v2-text-text-faint"))
  })

  test.each([false, true])("background layers step away from the base surface (dark: %s)", (isDark) => {
    const tokens = derive(isDark ? theme.dark : theme.light, isDark)
    const steps = [1, 2, 3, 4].map((step) => lightness(resolve(tokens, `v2-background-bg-layer-0${step}`)))
    const base = lightness(resolve(tokens, "v2-background-bg-base"))

    expect(new Set([base, ...steps]).size).toBe(5)

    for (let index = 1; index < steps.length; index++) {
      expect(isDark ? steps[index]! > steps[index - 1]! : steps[index]! < steps[index - 1]!).toBe(true)
    }
  })

  test("semantic tokens resolve to primitives emitted for the same theme", () => {
    for (const isDark of [false, true]) {
      const tokens = derive(isDark ? theme.dark : theme.light, isDark)

      for (const [token, value] of Object.entries(tokens)) {
        const ramp = /^var\(--v2-(grey|blue|green|yellow|red|purple|pink|orange|cyan)-(\d+)\)$/
        const reference = typeof value === "string" ? value.match(ramp) : undefined

        if (!reference) continue
        expect({ token, primitive: `v2-${reference[1]}-${reference[2]}` in tokens }).toEqual({ token, primitive: true })
      }
    }
  })
})

describe("explicit overrides win", () => {
  test.each([false, true])("matrix v2Overrides apply verbatim over derived values (dark: %s)", (isDark) => {
    const variant = isDark ? matrix.dark : matrix.light
    const overrides = variant.v2Overrides ?? {}
    const tokens = resolveThemeVariantV2(variant, isDark)
    const derived = derive(variant, isDark)

    expect(Object.keys(overrides).length).toBe(9)

    for (const [token, value] of Object.entries(overrides)) {
      expect({ token, value: tokens[token] }).toEqual({ token, value: value as string })
    }

    expect(tokens["v2-background-bg-layer-01"]).toBe(derived["v2-background-bg-layer-01"]!)
    expect(tokens["v2-background-bg-accent"]).not.toBe(derived["v2-background-bg-accent"]!)
  })

  test("a direct override replaces the derived value", () => {
    const tokens = resolveThemeVariantV2(
      { ...theme.light, v2Overrides: { "v2-background-bg-base": "#123456" } },
      false,
    )

    expect(tokens["v2-background-bg-base"]).toBe("#123456")
    expect(tokens["v2-background-bg-layer-01"]).toBe(mapV2Semantics(false)["v2-background-bg-layer-01"]!)
  })
})

function readDeclarations(section: string) {
  const tokens = new Map<string, string>()

  for (const match of section.matchAll(/--(v2-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const token = match[1]!

    if (token.startsWith("v2-font-family-")) continue
    tokens.set(token, match[2]!.replace(/\s+/g, " ").trim())
  }

  return tokens
}

function resolve(tokens: ResolvedV2Theme, token: string, seen = new Set<string>()): HexColor {
  const value = tokens[token]

  if (typeof value !== "string") throw new Error(`Missing token ${token}`)
  if (value.startsWith("#")) return value as HexColor
  if (seen.has(token)) throw new Error(`Circular reference at ${token}`)

  const reference = value.match(/^var\(--([a-z0-9-]+)\)$/)

  if (!reference) throw new Error(`Cannot resolve ${token}: ${value}`)

  return resolve(tokens, reference[1]!, new Set([...seen, token]))
}

function lightness(hex: HexColor) {
  return hexToOklch(hex).l
}
