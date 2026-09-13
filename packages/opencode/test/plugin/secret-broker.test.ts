import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Allowlist } from "../../src/plugin/secret-broker/allowlist"
import { bootstrap } from "../../src/plugin/secret-broker/bootstrap"
import { parse } from "../../src/plugin/secret-broker/env-loader"
import { check, denialMessage } from "../../src/plugin/secret-broker/protection"
import { Redactor, StreamRedactor } from "../../src/plugin/secret-broker/redactor"
import {
  REDACTION_WITHHELD,
  SecretBroker,
  redactErrorText,
  redactOnFailure,
  secretBrokerPlugin,
} from "../../src/plugin/secret-broker/index"
import { Plugin } from "../../src/plugin"
import { Cause, Effect, Exit } from "effect"

const dirs: string[] = []

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "secret-broker-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("env-loader", () => {
  test("parses assignments, export, quotes and comments", () => {
    const parsed = parse(
      [
        "# comment",
        "API_KEY=plain",
        "export TOKEN=abc12345",
        'PASSWORD="p@ss word"',
        "SINGLE='raw $value'",
        "TRAILING=value # inline comment",
        "",
      ].join("\n"),
    )
    expect(parsed.values.get("API_KEY")).toBe("plain")
    expect(parsed.values.get("TOKEN")).toBe("abc12345")
    expect(parsed.values.get("PASSWORD")).toBe("p@ss word")
    expect(parsed.values.get("SINGLE")).toBe("raw $value")
    expect(parsed.values.get("TRAILING")).toBe("value")
  })

  test("ignores malformed lines and non-assignments", () => {
    const parsed = parse("not an assignment\n=broken\nGOOD=1")
    expect(parsed.values.get("GOOD")).toBe("1")
    expect(parsed.values.size).toBe(1)
  })
})

describe("allowlist snapshot (Threat F)", () => {
  test("session edit of .env.example does not expand the frozen snapshot", async () => {
    const dir = tmp()
    const example = path.join(dir, ".env.example")
    writeFileSync(example, "A_KEY=1\nB_KEY=2\n")

    const allowlist = await Allowlist.snapshot(example)
    expect(allowlist.has("A_KEY")).toBe(true)
    expect(allowlist.has("C_KEY")).toBe(false)

    // agent writes a new key mid-session
    writeFileSync(example, "A_KEY=1\nB_KEY=2\nC_KEY=3\n")
    expect(allowlist.has("C_KEY")).toBe(false)
    expect(allowlist.size).toBe(2)
  })

  test("missing allowlisted keys are reported without values", async () => {
    const dir = tmp()
    const example = path.join(dir, ".env.example")
    writeFileSync(example, "A_KEY=\nB_KEY=\n")
    const allowlist = await Allowlist.snapshot(example)
    const result = allowlist.select(new Map([["A_KEY", "present"]]))
    expect(result.env).toEqual({ A_KEY: "present" })
    expect(result.missing).toEqual(["B_KEY"])
  })
})

describe("redactor", () => {
  test("longest-first exact replacement", () => {
    const redactor = new Redactor(
      [
        { key: "SHORT", value: "supersecretval" },
        { key: "LONG", value: "supersecretvalue_extended" },
      ],
      8,
    )
    const out = redactor.redact("x supersecretvalue_extended y supersecretval z")
    expect(out).toBe("x secret://project/LONG y secret://project/SHORT z")
  })

  test("min length guard skips short values", () => {
    const redactor = new Redactor([{ key: "TINY", value: "abc" }], 8)
    expect(redactor.size).toBe(0)
    expect(redactor.redact("abc stays abc")).toBe("abc stays abc")
  })

  test("redactDeep walks nested output metadata", () => {
    const redactor = new Redactor([{ key: "API_KEY", value: "sk-abcdefgh" }], 8)
    const result = redactor.redactDeep({ msg: "leak sk-abcdefgh", list: ["sk-abcdefgh"], n: 3 })
    expect(result.msg).toBe("leak secret://project/API_KEY")
    expect(result.list[0]).toBe("secret://project/API_KEY")
    expect(result.n).toBe(3)
  })

  test("base64 (standard + url-safe, padded + unpadded) maps to the same handle", () => {
    const value = "sk-abcdefgh"
    const redactor = new Redactor([{ key: "API_KEY", value }], 8)
    const bytes = Buffer.from(value, "utf8")
    for (const encoded of [
      bytes.toString("base64"),
      bytes.toString("base64").replace(/=+$/, ""),
      bytes.toString("base64url"),
      bytes.toString("base64url").replace(/=+$/, ""),
    ]) {
      expect(encoded.length).toBeGreaterThanOrEqual(12)
      expect(redactor.redact(`token=${encoded}`)).toBe("token=secret://project/API_KEY")
    }
  })

  test("hex-encoded variant maps to the same handle", () => {
    const redactor = new Redactor([{ key: "CANARY", value: "sk-abcdefgh" }], 8)
    const hex = Buffer.from("sk-abcdefgh", "utf8").toString("hex")
    expect(redactor.redact(`dump=${hex}`)).toBe("dump=secret://project/CANARY")
    expect(redactor.redact(`dump=${hex}`)).not.toContain(hex)
  })

  test("url-encoded and json-escaped variants map to the same handle", () => {
    const value = 'p@ss word"x\\y'
    const redactor = new Redactor([{ key: "PASSWORD", value }], 8)
    expect(redactor.redact(`q=${encodeURIComponent(value)}`)).toBe("q=secret://project/PASSWORD")
    expect(redactor.redact(`{"k":"${JSON.stringify(value).slice(1, -1)}"}`)).toBe(
      '{"k":"secret://project/PASSWORD"}',
    )
  })

  test("shell single-quote escaped variant maps to the same handle", () => {
    const redactor = new Redactor([{ key: "API_KEY", value: "it's secret" }], 8)
    expect(redactor.redact(`export K='it'\\''s secret'`)).toBe("export K='secret://project/API_KEY'")
  })

  test("longest-first ordering holds across variants", () => {
    const redactor = new Redactor(
      [
        { key: "LONG", value: "supersecretvalue_extended" },
        { key: "SHORT", value: "supersecretval" },
      ],
      8,
    )
    expect(redactor.redact("a supersecretvalue_extended b supersecretval")).toBe(
      "a secret://project/LONG b secret://project/SHORT",
    )
  })

  test("base64 shorter than the 12-char floor is skipped (precision guard)", () => {
    // "abcd1234" (8 bytes) -> "YWJjZDEyMzQ=" is 12 chars (kept); a 5-byte value
    // yields an 8-char base64 that must be dropped even though plain clears min.
    const redactor = new Redactor([{ key: "K", value: "abcde" }], 5)
    expect(redactor.redact("YWJjZGU=")).toBe("YWJjZGU=")
    expect(redactor.redact("abcde")).toBe("secret://project/K")
  })

  test("split secret across two chunks never leaks (streaming boundary)", () => {
    const redactor = new Redactor([{ key: "API_KEY", value: "sk-abcdefgh" }], 8)
    const stream = new StreamRedactor(redactor)
    let seen = ""
    seen += stream.push("prefix sk-abc")
    seen += stream.push("defgh suffix")
    seen += stream.flush()
    expect(seen).not.toContain("sk-abcdefgh")
    expect(seen).toBe("prefix secret://project/API_KEY suffix")
  })

  test("split secret byte-by-byte never leaks", () => {
    const redactor = new Redactor([{ key: "API_KEY", value: "sk-abcdefgh" }], 8)
    const stream = new StreamRedactor(redactor)
    const input = "x sk-abcdefgh y"
    let seen = ""
    for (const char of input) seen += stream.push(char)
    seen += stream.flush()
    expect(seen).not.toContain("sk-abcdefgh")
    expect(seen).toBe("x secret://project/API_KEY y")
  })

  test("stream redaction fails closed when the redactor throws", () => {
    const redactor = new Redactor([{ key: "API_KEY", value: "sk-abcdefgh" }], 8)
    const stream = new StreamRedactor(redactor)
    redactor.redact = () => {
      throw new Error("redactor boom")
    }
    const out = stream.push("raw sk-abcdefgh leak")
    expect(out).not.toContain("sk-abcdefgh")
    expect(out).toContain("withheld")
    expect(stream.flush()).toContain("withheld")
  })
})

describe("protection", () => {
  test("denies .env, .env.local, pem/key/id_rsa for read/edit/write", () => {
    for (const tool of ["read", "edit", "write"]) {
      expect(check(tool, { filePath: "/p/.env" })).toBeDefined()
      expect(check(tool, { filePath: "/p/.env.local" })).toBeDefined()
      expect(check(tool, { filePath: "/p/server.pem" })).toBeDefined()
      expect(check(tool, { filePath: "/p/key.pem" })).toBeDefined()
      expect(check(tool, { filePath: "/p/id_rsa" })).toBeDefined()
      expect(check(tool, { filePath: "/p/id_ed25519.pub" })).toBeDefined()
    }
  })

  test("allows .env.example and .env.sample", () => {
    expect(check("read", { filePath: "/p/.env.example" })).toBeUndefined()
    expect(check("read", { filePath: "/p/.env.sample" })).toBeUndefined()
    expect(check("edit", { filePath: "/p/.env.example" })).toBeUndefined()
  })

  test("ignores non-file tools and empty paths", () => {
    expect(check("bash", { filePath: "/p/.env" })).toBeUndefined()
    expect(check("read", {})).toBeUndefined()
  })

  test("covers both filePath and path arg keys", () => {
    expect(check("read", { path: "/p/.env" })).toBeDefined()
    expect(check("edit", { path: "/p/server.pem" })).toBeDefined()
    expect(check("read", { path: "/p/.env.example" })).toBeUndefined()
  })

  test("denial message carries no file contents", () => {
    const msg = denialMessage({ tool: "read", filePath: "/p/.env" })
    expect(msg).toContain(".env.example")
  })
})

describe("bootstrap", () => {
  test("creates .env.example from .env, blanking secret-like keys", async () => {
    const dir = tmp()
    const env = path.join(dir, ".env")
    const example = path.join(dir, ".env.example")
    writeFileSync(env, "API_KEY=supersecretvalue\nPORT=3000\nPRIVATE_KEY=xyz\n")
    const result = await bootstrap(env, example)
    expect(result.created).toBe(true)
    expect(result.total).toBe(3)
    expect(result.redacted).toBe(2)
    const text = await Bun.file(example).text()
    expect(text).toContain("API_KEY=")
    expect(text).not.toContain("supersecretvalue")
    expect(text).toContain("PORT=3000")
    expect(text).not.toContain("xyz")
  })

  test("never clobbers an existing example and no-ops without .env", async () => {
    const dir = tmp()
    const example = path.join(dir, ".env.example")
    writeFileSync(example, "EXISTING=keep\n")
    writeFileSync(path.join(dir, ".env"), "API_KEY=supersecretvalue\n")
    const result = await bootstrap(path.join(dir, ".env"), example)
    expect(result.created).toBe(false)
    expect(await Bun.file(example).text()).toBe("EXISTING=keep\n")

    const empty = tmp()
    expect(existsSync(path.join(empty, ".env"))).toBe(false)
    expect((await bootstrap(path.join(empty, ".env"), path.join(empty, ".env.example"))).created).toBe(false)
  })
})

describe("SecretBroker + hooks acceptance", () => {
  test("no .env -> hooks no-op, no injection, no denial change", async () => {
    const dir = tmp()
    const broker = await SecretBroker.create(dir)
    expect(broker.shellEnv()).toEqual({})
    expect(broker.diagnostics().allowlisted).toBe(0)
  })

  test("injects only allowlisted keys present at startup", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "API_KEY=\n")
    writeFileSync(path.join(dir, ".env"), "API_KEY=sk-abcdefgh\nUNDECLARED=leakme123456\n")
    const broker = await SecretBroker.create(dir)
    expect(broker.shellEnv()).toEqual({ API_KEY: "sk-abcdefgh" })
    expect(broker.shellEnv().UNDECLARED).toBeUndefined()
  })

  test("allowlisted-but-missing key is left unset with safe diagnostic", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "API_KEY=\nMISSING_KEY=\n")
    writeFileSync(path.join(dir, ".env"), "API_KEY=sk-abcdefgh\n")
    const broker = await SecretBroker.create(dir)
    expect(broker.shellEnv()).toEqual({ API_KEY: "sk-abcdefgh" })
    expect(broker.diagnostics().missing).toEqual(["MISSING_KEY"])
  })

  test("shell.env hook mutates output.env", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "API_KEY=\n")
    writeFileSync(path.join(dir, ".env"), "API_KEY=sk-abcdefgh\n")
    const hooks = await secretBrokerPlugin({ directory: dir } as any)
    const output = { env: {} as Record<string, string> }
    await hooks["shell.env"]!({ cwd: dir }, output)
    expect(output.env.API_KEY).toBe("sk-abcdefgh")
  })

  test("tool.execute.before throws on protected file, allows example", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "API_KEY=\n")
    const hooks = await secretBrokerPlugin({ directory: dir } as any)
    await expect(
      hooks["tool.execute.before"]!({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: ".env" } }),
    ).rejects.toThrow(/Secret Broker blocked read/)
    await expect(
      hooks["tool.execute.before"]!(
        { tool: "read", sessionID: "s", callID: "c" },
        { args: { filePath: ".env.example" } },
      ),
    ).resolves.toBeUndefined()
  })

  test("tool.execute.after redacts output, title, metadata and error text", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "API_KEY=\n")
    writeFileSync(path.join(dir, ".env"), "API_KEY=sk-abcdefgh\n")
    const hooks = await secretBrokerPlugin({ directory: dir } as any)
    const output = {
      title: "run sk-abcdefgh",
      output: "error: leaked sk-abcdefgh in stderr",
      metadata: { nested: { token: "sk-abcdefgh" } },
    }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s", callID: "c", args: {} },
      output,
    )
    expect(output.output).not.toContain("sk-abcdefgh")
    expect(output.output).toContain("secret://project/API_KEY")
    expect(output.title).toBe("run secret://project/API_KEY")
    expect(output.metadata.nested.token).toBe("secret://project/API_KEY")
  })

  test("after-hook fails closed when redaction throws (spec §31)", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "API_KEY=\n")
    writeFileSync(path.join(dir, ".env"), "API_KEY=sk-abcdefgh\n")
    const hooks = await secretBrokerPlugin({ directory: dir } as any)
    const metadata = {} as Record<string, unknown>
    Object.defineProperty(metadata, "boom", {
      enumerable: true,
      get() {
        throw new Error("redactor boom")
      },
    })
    const output = { title: "t", output: "raw sk-abcdefgh leak", metadata }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s", callID: "c", args: {} },
      output,
    )
    expect(output.output).not.toContain("sk-abcdefgh")
    expect(output.output).toContain("withheld")
    expect(output.metadata).toBeUndefined()
  })

  test("messages.transform redacts interrupted live tool output before it reaches the model", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "API_KEY=\n")
    writeFileSync(path.join(dir, ".env"), "API_KEY=sk-abcdefgh\n")
    const hooks = await secretBrokerPlugin({ directory: dir } as any)
    // Mirrors processor.ts interrupt marking + message-v2 projection: the raw
    // live output sits in tool-part metadata.output and would reach the model.
    const messages = [
      {
        info: { id: "m1", role: "assistant" as const },
        parts: [
          {
            type: "tool" as const,
            tool: "bash",
            callID: "c1",
            state: {
              status: "error" as const,
              error: "Tool execution aborted",
              metadata: { interrupted: true, output: "live sk-abcdefgh leak" },
              time: { start: 0, end: 1 },
            },
          },
        ],
      },
    ]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: messages as any })
    const projected = JSON.stringify(messages)
    expect(projected).not.toContain("sk-abcdefgh")
    expect(projected).toContain("secret://project/API_KEY")
  })

  test("messages.transform fails closed (blanks parts) when redaction throws", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "API_KEY=\n")
    writeFileSync(path.join(dir, ".env"), "API_KEY=sk-abcdefgh\n")
    const hooks = await secretBrokerPlugin({ directory: dir } as any)
    const part = { type: "tool", output: "raw sk-abcdefgh" }
    Object.defineProperty(part, "boom", {
      enumerable: true,
      get() {
        throw new Error("redactor boom")
      },
    })
    const messages = [{ info: { id: "m1", role: "assistant" }, parts: [part] }]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: messages as any })
    expect(JSON.stringify(messages)).not.toContain("sk-abcdefgh")
  })
})

describe("bootstrap default-deny (Critical: credential-like values blanked)", () => {
  test("blanks DATABASE_URL, MONGO_URI, SENTRY_DSN, WEBHOOK_URL, SMTP_URL", async () => {
    const dir = tmp()
    const env = path.join(dir, ".env")
    const example = path.join(dir, ".env.example")
    writeFileSync(
      env,
      [
        "DATABASE_URL=postgres://user:pass@host/db",
        "MONGO_URI=mongodb://user:pass@host",
        "SENTRY_DSN=https://key@sentry.io/123",
        "WEBHOOK_URL=https://hooks.example/abc",
        "SMTP_URL=smtp://user:pass@mail",
      ].join("\n") + "\n",
    )
    const result = await bootstrap(env, example)
    expect(result.created).toBe(true)
    expect(result.total).toBe(5)
    expect(result.redacted).toBe(5)
    const text = await Bun.file(example).text()
    expect(text).not.toContain("postgres://")
    expect(text).not.toContain("mongodb://")
    expect(text).not.toContain("sentry.io")
    expect(text).not.toContain("hooks.example")
    expect(text).not.toContain("smtp://")
    expect(text).toContain("DATABASE_URL=\n")
  })

  test("preserves only safe-config keys, blanks everything else", async () => {
    const dir = tmp()
    const env = path.join(dir, ".env")
    const example = path.join(dir, ".env.example")
    writeFileSync(env, "APP_ENV=production\nPORT=8080\nNODE_ENV=dev\nFEATURE_ENABLED=true\nMYSTERY=leakme\n")
    const result = await bootstrap(env, example)
    expect(result.redacted).toBe(1)
    const text = await Bun.file(example).text()
    expect(text).toContain("APP_ENV=production")
    expect(text).toContain("PORT=8080")
    expect(text).toContain("FEATURE_ENABLED=true")
    expect(text).toContain("MYSTERY=")
    expect(text).not.toContain("leakme")
  })

  test("writes .env.example with mode 0o600", async () => {
    const dir = tmp()
    const env = path.join(dir, ".env")
    const example = path.join(dir, ".env.example")
    writeFileSync(env, "PORT=8080\n")
    await bootstrap(env, example)
    expect(statSync(example).mode & 0o777).toBe(0o600)
  })
})

describe("protection (High: case-fold, .envrc, symlink)", () => {
  test("blocks uppercase .ENV variants", () => {
    expect(check("read", { filePath: "/p/.ENV" })).toBeDefined()
    expect(check("read", { filePath: "/p/.Env.Local" })).toBeDefined()
    expect(check("read", { filePath: "/p/SERVER.PEM" })).toBeDefined()
    expect(check("read", { filePath: "/p/ID_RSA" })).toBeDefined()
  })

  test("blocks .envrc but still allows .env.example (case-insensitive)", () => {
    expect(check("read", { filePath: "/p/.envrc" })).toBeDefined()
    expect(check("read", { filePath: "/p/.ENV.EXAMPLE" })).toBeUndefined()
  })

  test("blocks a symlink whose resolved target is a protected file", () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env"), "API_KEY=sk-abcdefgh\n")
    const link = path.join(dir, "readme.txt")
    symlinkSync(path.join(dir, ".env"), link)
    expect(check("read", { filePath: link })).toBeDefined()
    expect(check("read", { filePath: path.join(dir, "readme.txt") })).toBeDefined()
  })

  test("does not throw or block on a nonexistent path", () => {
    expect(check("read", { filePath: "/p/does-not-exist.txt" })).toBeUndefined()
  })
})

describe("minLength consistency (High: short values not injected nor redacted)", () => {
  test("select drops short values, marking them missing", async () => {
    const dir = tmp()
    const example = path.join(dir, ".env.example")
    writeFileSync(example, "SHORT=\nLONG=\n")
    const allowlist = await Allowlist.snapshot(example)
    const result = allowlist.select(new Map([["SHORT", "abc"], ["LONG", "longenoughvalue"]]), 8)
    expect(result.env).toEqual({ LONG: "longenoughvalue" })
    expect(result.missing).toEqual(["SHORT"])
  })

  test("broker neither injects nor redacts a short allowlisted value", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "SHORT=\nLONG=\n")
    writeFileSync(path.join(dir, ".env"), "SHORT=abc\nLONG=longenoughvalue\n")
    const broker = await SecretBroker.create(dir)
    expect(broker.shellEnv()).toEqual({ LONG: "longenoughvalue" })
    expect(broker.redact("has abc and longenoughvalue")).toBe("has abc and secret://project/LONG")
    expect(broker.diagnostics().missing).toContain("SHORT")
  })
})

describe("redaction helpers (fail-closed)", () => {
  const plugin = (trigger: Plugin.Interface["trigger"]): Plugin.Interface =>
    Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]), trigger })

  const redacting = ((_name: unknown, _input: unknown, output: { output: string }) => {
    output.output = "redacted sk-========"
    return Effect.succeed(output)
  }) as unknown as Plugin.Interface["trigger"]

  test("redactErrorText withholds text when the redactor throws (spec §31)", async () => {
    const throwing = (() => Effect.die(new Error("redactor boom"))) as Plugin.Interface["trigger"]
    const result = await Effect.runPromise(
      redactErrorText({
        plugin: plugin(throwing),
        tool: "bash",
        sessionID: "s",
        callID: "c",
        args: {},
        text: "raw sk-abcdefgh leak",
      }),
    )
    expect(result).toBe(REDACTION_WITHHELD)
    expect(result).not.toContain("sk-abcdefgh")
  })

  test("redactOnFailure redacts the message while preserving error identity", async () => {
    const error = new Error("boom leaked sk-abcdefgh")
    const exit = await Effect.runPromiseExit(
      redactOnFailure({
        plugin: plugin(redacting),
        tool: "bash",
        sessionID: "s",
        callID: "c",
        args: {},
        cause: Cause.fail(error),
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error)
    expect(error.message).toBe("redacted sk-========")
  })

  test("redactOnFailure passes interrupt-only causes through untouched", async () => {
    let called = false
    const spy = ((_name: unknown, _input: unknown, output: unknown) => {
      called = true
      return Effect.succeed(output)
    }) as unknown as Plugin.Interface["trigger"]
    const cause = Cause.interrupt(1)
    const exit = await Effect.runPromiseExit(
      redactOnFailure({ plugin: plugin(spy), tool: "bash", sessionID: "s", callID: "c", args: {}, cause }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(called).toBe(false)
  })
})
