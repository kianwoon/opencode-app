import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../../src/session/instruction"
import { Truncate } from "@/tool/truncate"
import { ReadTool } from "../../src/tool/read"
import { SymbolsTool, formatOutline, noSymbolParserMessage, parseSymbols } from "../../src/tool/symbols"
import type * as Tool from "../../src/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-symbols-"))
afterAll(() => fs.rm(dir, { recursive: true, force: true }))
const putSync = (name: string, content: string) => fs.writeFile(path.join(dir, name), content)

const SOURCE = [
  "interface Shape {",
  "  area(): number",
  "}",
  "",
  "class Circle implements Shape {",
  "  radius = 1",
  "  area() {",
  "    return 3",
  "  }",
  "}",
  "",
  "export function makeCircle(): Circle {",
  "  return new Circle()",
  "}",
  "",
  "const helper = () => 42",
].join("\n")

describe("symbols outline", () => {
  test("outlines a .ts file with normalized kinds, depth and 1-indexed ranges", async () => {
    await putSync("sample.ts", SOURCE)
    const symbols = await parseSymbols(path.join(dir, "sample.ts"))
    expect(formatOutline(symbols ?? [])).toBe(
      [
        "Shape  interface  L1-L3",
        "Circle  class  L5-L10",
        "  area  method  L7-L9",
        "makeCircle  function  L12-L14",
        "helper  function  L16-L16",
      ].join("\n"),
    )
  })

  test("selects the TSX grammar for .tsx (JSX parses as elements, methods included)", async () => {
    await putSync(
      "component.tsx",
      ["export function App() {", "  return <div />", "}", "", "class Box {", "  render() {", "    return <span />", "  }", "}"].join(
        "\n",
      ),
    )
    const symbols = await parseSymbols(path.join(dir, "component.tsx"))
    expect(formatOutline(symbols ?? [])).toBe(
      ["App  function  L1-L3", "Box  class  L5-L9", "  render  method  L6-L8"].join("\n"),
    )
  })

  test("selects the JavaScript grammar for .mjs", async () => {
    await putSync("mod.mjs", ["export function mjsFn() {}", "const arrow = () => 1"].join("\n"))
    const symbols = await parseSymbols(path.join(dir, "mod.mjs"))
    expect(formatOutline(symbols ?? [])).toBe(["mjsFn  function  L1-L1", "arrow  function  L2-L2"].join("\n"))
  })

  test("a file with zero declarations yields an empty outline", async () => {
    await putSync("empty.ts", "const x = 1\nconsole.log(x)\n")
    const symbols = await parseSymbols(path.join(dir, "empty.ts"))
    expect(symbols).toEqual([])
    expect(formatOutline(symbols ?? [])).toBe("")
  })

  test("unsupported extension reports the no-parser message", async () => {
    await putSync("script.py", "def f():\n    return 1\n")
    expect(await parseSymbols(path.join(dir, "script.py"))).toBeUndefined()
    expect(noSymbolParserMessage(path.join(dir, "script.py"))).toBe("no symbol parser for .py")
  })
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const toolLayer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    LSP.node,
    Ripgrep.node,
    Truncate.node,
  ]),
)
const it = testEffect(Layer.mergeAll(toolLayer, testInstanceStoreLayer))

const put = Effect.fn("SymbolsTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const readTool = Effect.fn("SymbolsTest.readTool")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const readExec = Effect.fn("SymbolsTest.readExec")(function* (
  instanceDir: string,
  args: Tool.InferParameters<typeof ReadTool>,
) {
  const tool = yield* readTool()
  return yield* provideInstance(instanceDir)(tool.execute(args, ctx))
})

const readFail = Effect.fn("SymbolsTest.readFail")(function* (
  instanceDir: string,
  args: Tool.InferParameters<typeof ReadTool>,
) {
  const exit = yield* readExec(instanceDir, args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const symbolsExec = Effect.fn("SymbolsTest.symbolsExec")(function* (
  instanceDir: string,
  args: Tool.InferParameters<typeof SymbolsTool>,
) {
  const info = yield* SymbolsTool
  const tool = yield* info.init()
  return yield* provideInstance(instanceDir)(tool.execute(args, ctx))
})

describe("tool.read symbol mode", () => {
  it.live("reads exactly the resolved symbol's lines", () =>
    Effect.gen(function* () {
      const instanceDir = yield* tmpdirScoped()
      yield* put(path.join(instanceDir, "sample.ts"), SOURCE)

      const result = yield* readExec(instanceDir, { filePath: path.join(instanceDir, "sample.ts"), symbol: "makeCircle" })

      expect(result.output).toContain("12: export function makeCircle(): Circle {")
      expect(result.output).not.toContain("class Circle")
    }),
  )

  it.live("rejects symbol combined with offset/limit", () =>
    Effect.gen(function* () {
      const instanceDir = yield* tmpdirScoped()
      yield* put(path.join(instanceDir, "sample.ts"), SOURCE)

      const err = yield* readFail(instanceDir, {
        filePath: path.join(instanceDir, "sample.ts"),
        symbol: "makeCircle",
        offset: 1,
      })
      expect(err.message).toContain("cannot be combined")
    }),
  )

  it.live("lists available symbols when the name is unknown", () =>
    Effect.gen(function* () {
      const instanceDir = yield* tmpdirScoped()
      yield* put(path.join(instanceDir, "sample.ts"), SOURCE)

      const err = yield* readFail(instanceDir, { filePath: path.join(instanceDir, "sample.ts"), symbol: "nope" })
      expect(err.message).toContain("Available symbols")
      expect(err.message).toContain("makeCircle")
    }),
  )

  it.live("reports no declarations for a zero-symbol file", () =>
    Effect.gen(function* () {
      const instanceDir = yield* tmpdirScoped()
      yield* put(path.join(instanceDir, "empty.ts"), "const x = 1\nconsole.log(x)\n")

      const err = yield* readFail(instanceDir, { filePath: path.join(instanceDir, "empty.ts"), symbol: "x" })
      expect(err.message).toContain("No declarations found")
    }),
  )
})

describe("tool.symbols", () => {
  it.live("reports no declarations for a zero-symbol file", () =>
    Effect.gen(function* () {
      const instanceDir = yield* tmpdirScoped()
      yield* put(path.join(instanceDir, "empty.ts"), "const x = 1\nconsole.log(x)\n")

      const result = yield* symbolsExec(instanceDir, { filePath: path.join(instanceDir, "empty.ts") })
      expect(result.output).toBe("(no declarations found)")
    }),
  )

  it.live("reports the no-parser message for unsupported extensions", () =>
    Effect.gen(function* () {
      const instanceDir = yield* tmpdirScoped()
      yield* put(path.join(instanceDir, "script.py"), "def f():\n    return 1\n")

      const result = yield* symbolsExec(instanceDir, { filePath: path.join(instanceDir, "script.py") })
      expect(result.output).toBe("no symbol parser for .py")
    }),
  )
})
