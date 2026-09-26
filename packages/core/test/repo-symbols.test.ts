import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
// Import order matters: filesystem.ts dereferences `FileSystemSearch.node` at
// module-evaluation time, so filesystem must be entered before search.ts (as the
// app does) or the namespace is still in TDZ.
import "../src/filesystem"
import { collectSymbols, loadParsers } from "../src/repo/symbols"
import { it } from "./lib/effect"

// Real wasm + real grammar; the fixture is a source string so the assertions stay
// about node shapes, not about the repo's own files moving under us.
const FIXTURE = [
  "export function alpha() {}",
  "class Beta {}",
  "interface Gamma {}",
  "type Delta = {}",
].join("\n")

const MANY = Array.from({ length: 12 }, (_, index) => `function sym${index}() {}`).join("\n")

it.effect("collects declarations with their kinds and lines", () =>
  Effect.gen(function* () {
    const parsers = yield* Effect.promise(() => loadParsers())
    const symbols = collectSymbols(parsers.typescript.parse(FIXTURE)!, 100)
    expect(symbols.map((hit) => [hit.name, hit.kind, hit.line])).toEqual([
      ["alpha", "function_declaration", 1],
      ["Beta", "class_declaration", 2],
      ["Gamma", "interface_declaration", 3],
      ["Delta", "type_alias_declaration", 4],
    ])
  }),
)

describe("collectSymbols", () => {
  test("truncates at the requested cap", async () => {
    const parsers = await loadParsers()
    expect(collectSymbols(parsers.typescript.parse(MANY)!, 5)).toHaveLength(5)
  })

  test("returns nothing for a source with no declarations", async () => {
    const parsers = await loadParsers()
    expect(collectSymbols(parsers.javascript.parse("const x = 1\nconsole.log(x)")!, 100)).toEqual([])
  })
})
