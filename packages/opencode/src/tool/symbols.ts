import { Effect, Schema } from "effect"
import path from "path"
import { collectSymbols, loadParsers, PARSER_BY_EXTENSION } from "@opencode-ai/core/repo/symbols"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./symbols.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to outline" }),
})

export type SymbolEntry = {
  readonly name: string
  readonly kind: string
  readonly depth: number
  readonly startLine: number
  readonly endLine: number
}

// Raw tree-sitter node types → stable concept labels, so a real function and an
// arrow-const function read as the same kind in the outline.
const KIND_LABELS: Record<string, string> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  function: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  method_definition: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
}

const SYMBOL_CAP = 100_000

export const parseSymbols = async (filePath: string): Promise<SymbolEntry[] | undefined> => {
  // Check the extension before loading wasm so an unsupported file never pays for a grammar.
  const key = PARSER_BY_EXTENSION[path.extname(filePath).toLowerCase()]
  if (!key) return undefined
  const parser = (await loadParsers())[key]
  const source = await Bun.file(filePath).text()
  const tree = parser.parse(source)
  if (!tree) return []
  const hits = collectSymbols(tree, SYMBOL_CAP, { detailed: true })
  tree.delete()
  return hits.map((hit) => ({
    name: hit.name,
    kind: KIND_LABELS[hit.kind] ?? hit.kind,
    depth: hit.depth ?? 0,
    startLine: hit.line,
    endLine: hit.endLine ?? hit.line,
  }))
}

export const formatOutline = (symbols: SymbolEntry[]): string =>
  symbols
    .map((symbol) => `${"  ".repeat(symbol.depth)}${symbol.name}  ${symbol.kind}  L${symbol.startLine}-L${symbol.endLine}`)
    .join("\n")

export const noSymbolParserMessage = (filePath: string) =>
  `no symbol parser for ${path.extname(filePath).toLowerCase()}`

export const SymbolsTool = Tool.define(
  "symbols",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.resolve(instance.directory, params.filePath)
          const title = path.relative(instance.worktree, filepath)

          yield* assertExternalDirectoryEffect(ctx, filepath, { bypass: false, kind: "file" })
          yield* ctx.ask({
            permission: "read",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {},
          })

          const symbols = yield* Effect.promise(() => parseSymbols(filepath))
          if (!symbols) {
            return {
              title,
              output: noSymbolParserMessage(filepath),
              metadata: { symbols: 0 },
            }
          }

          return {
            title,
            output: symbols.length === 0 ? "(no declarations found)" : formatOutline(symbols),
            metadata: { symbols: symbols.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
