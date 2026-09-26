export * as Symbols from "./symbols"

import { FileSystemWatcher } from "@opencode-ai/schema/filesystem-watcher"
import { Context, Effect, Layer, Scope, Stream } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import type { Node, Parser, Tree } from "web-tree-sitter"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { FileSystemSearch } from "../filesystem/search"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"

const SYMBOLS_MAX_FILES = 3000
const SYMBOLS_PER_FILE_CAP = 500
const SYMBOLS_TOTAL_CAP = 50_000
const SYMBOLS_DIRTY_BATCH = 200

const DECLARATION_NODES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
])

const SOURCE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"]

export type Hit = {
  readonly path: string
  readonly line: number
  readonly kind: string
  readonly name: string
}

// The wasm assets are addressed as bare specifiers, so they only resolve from a
// module inside the package that declares them — always resolve against this
// module's own URL rather than assuming a hoisted location.
const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

type Parsers = {
  readonly typescript: Parser
  readonly javascript: Parser
}

let loaders: Promise<Parsers> | undefined

// Lazy and in-branch: importing web-tree-sitter and the grammar wasm eagerly
// would instantiate wasm for every process that never runs a symbol query.
export const loadParsers = () => {
  if (loaders) return loaders
  const pending = (async (): Promise<Parsers> => {
    const { Parser: TreeSitter, Language } = await import("web-tree-sitter")
    const { default: runtimeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
      with: { type: "wasm" },
    })
    await TreeSitter.init({ locateFile: () => resolveWasm(runtimeWasm) })
    const { default: tsWasm } = await import("tree-sitter-typescript/tree-sitter-typescript.wasm" as string, {
      with: { type: "wasm" },
    })
    const { default: jsWasm } = await import("tree-sitter-javascript/tree-sitter-javascript.wasm" as string, {
      with: { type: "wasm" },
    })
    const [typescript, javascript] = await Promise.all([
      Language.load(resolveWasm(tsWasm)),
      Language.load(resolveWasm(jsWasm)),
    ])
    const tsParser = new TreeSitter()
    tsParser.setLanguage(typescript)
    const jsParser = new TreeSitter()
    jsParser.setLanguage(javascript)
    return { typescript: tsParser, javascript: jsParser }
  })()
  loaders = pending
  return pending
}

// functions/generators name themselves with `identifier`; class, interface, type and
// enum declarations name themselves with `type_identifier`.
const NAME_NODES = new Set(["identifier", "type_identifier"])

const declaredName = (node: Node) => {
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index)
    if (!child || !NAME_NODES.has(child.type)) continue
    return child.text
  }
  return undefined
}

const visit = (node: Node, out: Hit[], cap: number) => {
  if (out.length >= cap) return
  // `export` wraps the real declaration, so step through it instead of matching it.
  if (node.type === "export_statement") {
    for (let index = 0; index < node.namedChildCount; index++) {
      const inner = node.namedChild(index)
      if (inner) visit(inner, out, cap)
    }
    return
  }
  if (DECLARATION_NODES.has(node.type)) {
    const name = declaredName(node)
    if (name) out.push({ path: "", line: node.startPosition.row + 1, kind: node.type, name })
  }
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child) visit(child, out, cap)
  }
}

/** Collects declarations only — v1 deliberately skips methods and variables. */
export const collectSymbols = (tree: Tree, cap: number) => {
  const out: Hit[] = []
  visit(tree.rootNode, out, cap)
  return out
}

export interface Interface {
  readonly query: (
    input: { name: string; limit: number },
  ) => Effect.Effect<
    { symbols: readonly Hit[]; building: boolean },
    Ripgrep.Error | Ripgrep.InvalidPatternError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Repo/Symbols") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const search = yield* FileSystemSearch.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope

    const index = new Map<string, Hit[]>()
    const dirty = new Set<string>()
    const state = { building: false, started: false }

    // Shared by populate and the incremental drain so both parse identically.
    const parseFile = (parsers: Parsers, file: string, cap: number) =>
      Effect.gen(function* () {
        const source = yield* fs.readFileStringSafe(path.resolve(location.directory, file)).pipe(Effect.orDie)
        if (source === undefined) return []
        const parser = file.endsWith(".ts") ? parsers.typescript : parsers.javascript
        const tree = parser.parse(source)
        if (!tree) return []
        return collectSymbols(tree, cap)
      })

    const populate = Effect.gen(function* () {
      const parsers = yield* Effect.promise(() => loadParsers())
      const listed = yield* search.list({ limit: SYMBOLS_MAX_FILES })
      const files = listed.paths.filter((file) => SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext)))
      let total = 0
      for (const file of files) {
        if (total >= SYMBOLS_TOTAL_CAP) break
        const hits = yield* parseFile(parsers, file, Math.min(SYMBOLS_PER_FILE_CAP, SYMBOLS_TOTAL_CAP - total))
        if (hits.length === 0) continue
        total += hits.length
        index.set(file, hits.map((hit) => ({ ...hit, path: file })))
      }
    })

    const ensure = Effect.gen(function* () {
      if (state.started) return
      state.started = true
      state.building = true
      // building flips back in a finalizer so a failed populate cannot strand it true.
      yield* populate.pipe(
        Effect.ensuring(Effect.sync(() => (state.building = false))),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    })

    // Pull-based: the watcher only records WHICH paths changed. Re-parsing is paid
    // by the next query, capped per call so a burst cannot stall one turn.
    const drain = Effect.gen(function* () {
      if (dirty.size === 0) return
      const parsers = yield* Effect.promise(() => loadParsers())
      const batch = Array.from(dirty).slice(0, SYMBOLS_DIRTY_BATCH)
      for (const file of batch) {
        dirty.delete(file)
        const hits = yield* parseFile(parsers, file, SYMBOLS_PER_FILE_CAP)
        if (hits.length === 0) {
          index.delete(file)
          continue
        }
        index.set(file, hits.map((hit) => ({ ...hit, path: file })))
      }
    })

    // Records WHICH paths changed, not what changed: a removal drops the path so a
    // deleted file can never re-enter through the drain.
    yield* Effect.forkScoped(
      events
        .subscribe(FileSystemWatcher.Event.Updated)
        .pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.location?.directory !== location.directory) return
              const relative = path.relative(location.directory, event.data.file)
              if (relative === "" || relative.startsWith("..")) return
              if (event.data.event === "unlink") {
                index.delete(relative)
                dirty.delete(relative)
                return
              }
              dirty.add(relative)
            }),
          ),
        ),
    )

    return Service.of({
      query: (input) =>
        Effect.gen(function* () {
          yield* ensure
          yield* drain
          const needle = input.name.toLowerCase()
          const symbols = [...index.values()]
            .flatMap((entries) => entries)
            .filter((hit) => hit.name.toLowerCase().includes(needle))
            .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
            .slice(0, input.limit)
          if (symbols.length > 0) return { symbols, building: state.building }
          // Never lie: the index is only a hint, so zero index hits — including
          // while it is still building — always fall back to a real ripgrep search.
          const found = yield* ripgrep.grep({
            cwd: location.directory,
            pattern: input.name,
            limit: 20,
          })
          return {
            symbols: found.map((match) => ({
              path: match.entry.path,
              line: match.line,
              kind: "text",
              name: input.name,
            })),
            building: state.building,
          }
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Ripgrep.node, FileSystemSearch.node, EventV2.node],
})
