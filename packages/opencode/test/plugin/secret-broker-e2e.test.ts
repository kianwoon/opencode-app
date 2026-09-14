// End-to-end attack suite for the Secret Broker.
//
// Threat model: an evil/compromised UPSTREAM LLM provider observes every token
// that reaches the model — tool output, tool errors, streamed chunks, and the
// final message transcript. It knows the plugin exists and will run every cheap
// deterministic transform (base64, URL-encode, JSON-escape, shell-quote) to
// reconstruct a secret from whatever leaks. The broker's guarantee is narrower
// but absolute: the only credential representation the model can ever SEE is a
// `secret://project/NAME` handle. Real secret bytes travel to the CHILD PROCESS
// environment only (shell.env), never through the model-visible channel.
//
// Each test drives the REAL hooks (`shell.env`, `tool.execute.before/after`,
// `experimental.chat.messages.transform`, `redactOnFailure`) over a canary and
// asserts BOTH: handle present AND canary absent in every encoding the redactor
// claims to cover. Network exfiltration is explicitly out of scope (spec §17):
// shell.env legitimately hands the secret to a child process, so a program the
// model wrote could POST it out; that is a sandbox/egress concern, not a broker
// regression. This suite proves the MODEL-VISIBLE channel only.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Cause, Effect } from "effect"
import { Plugin } from "../../src/plugin"
import {
  REDACTION_WITHHELD,
  SecretBroker,
  redactOnFailure,
  secretBrokerPlugin,
} from "../../src/plugin/secret-broker/index"
import { Redactor, StreamRedactor } from "../../src/plugin/secret-broker/redactor"

// ── Canary ──────────────────────────────────────────────────────────────────
// Chosen so that plain, URL-encoded, JSON-escaped and base64 forms are all
// DISTINCT and >= the redactor's 12-char base64 floor. A leak in ANY transform
// is a real breach the broker must have prevented.
const CANARY = "sk-live/CAN+ARY=0123456789abcdef"
const HANDLE = "secret://project/CANARY_KEY"

/** Every deterministic transformation the redactor claims to cover. */
function encodings(secret: string): string[] {
  const b64 = Buffer.from(secret, "utf8")
  return [
    secret,
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    secret.replace(/'/g, `'\\''`),
    b64.toString("base64"),
    b64.toString("base64url"),
    b64.toString("base64").replace(/=+$/, ""),
    b64.toString("base64url").replace(/=+$/, ""),
    // Hex is covered by the redactor (hexVariants) down to its 12-char floor;
    // CANARY is long enough that its 2-chars-per-byte hex form clears it.
    b64.toString("hex"),
  ]
}

/** Asserts the canary is gone in all encodings and the handle is present. */
function assertSanitized(text: string, label: string) {
  for (const variant of encodings(CANARY)) {
    expect(text, `${label}: leaked ${variant}`).not.toContain(variant)
  }
  expect(text, `${label}: handle missing`).toContain(HANDLE)
}

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "secret-broker-e2e-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Seeds a project with a canary secret declared in .env.example. */
function seed(canary = CANARY): string {
  const dir = tmp()
  writeFileSync(path.join(dir, ".env.example"), "CANARY_KEY=\n")
  writeFileSync(path.join(dir, ".env"), `CANARY_KEY=${canary}\n`)
  return dir
}

/** Real hooks backed by the plugin under test. */
async function hooksFor(dir: string) {
  return secretBrokerPlugin({ directory: dir } as never)
}

/** A Plugin.Interface whose `trigger` dispatches into the real hooks, so
 *  `redactOnFailure`/`redactErrorText` exercise the production path. */
function pluginOf(hooks: Awaited<ReturnType<typeof hooksFor>>): Plugin.Interface {
  return Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger: (name, input, output) =>
      Effect.promise(async () => {
        const hook = (hooks as Record<string, ((i: unknown, o: unknown) => Promise<void>) | undefined>)[name]
        if (hook) await hook(input, output)
        return output
      }),
  })
}

describe("secret-broker e2e — model-visible channel never carries the canary", () => {
  test("1. printenv dump echoed through a tool result is redacted", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    // The child process legitimately received the secret; `printenv` printed it.
    const output = {
      title: "printenv",
      output: `PATH=/usr/bin\nCANARY_KEY=${CANARY}\nHOME=/root`,
      metadata: { exit: 0 },
    }
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output as never)
    assertSanitized(JSON.stringify(output), "printenv dump")
  })

  test("2. single-value leak (node -e console.log(process.env.X)) is redacted", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    const output = { title: "bash", output: CANARY, metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output as never)
    assertSanitized(output.output, "single value")
  })

  test("3. thrown error 'Invalid credential <canary>' is redacted via redactOnFailure", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    const plugin = pluginOf(hooks)
    const error = new Error(`Invalid credential ${CANARY}`)
    const exit = await Effect.runPromiseExit(
      redactOnFailure({ plugin, tool: "bash", sessionID: "s", callID: "c", args: {}, cause: Cause.fail(error) }),
    )
    expect(exit._tag).toBe("Failure")
    // Identity preserved (control-flow), message sanitized (model-visible).
    if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBe(error)
    assertSanitized(error.message, "thrown error")
  })

  test("4. base64 and url-encoded canary in output map to the handle", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    const output = {
      title: "bash",
      output: `b64=${Buffer.from(CANARY).toString("base64")} url=${encodeURIComponent(CANARY)}`,
      metadata: {},
    }
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output as never)
    assertSanitized(output.output, "encoded output")
  })

  test("5. canary split across 3 stream chunks never leaks a fragment", () => {
    const redactor = new Redactor([{ key: "CANARY_KEY", value: CANARY }], 8)
    const stream = new StreamRedactor(redactor)
    const third = Math.ceil(CANARY.length / 3)
    const chunks = [CANARY.slice(0, third), CANARY.slice(third, third * 2), CANARY.slice(third * 2)]
    let released = ""
    for (const chunk of chunks) released += stream.push(chunk)
    released += stream.flush()
    assertSanitized(released, "streamed chunks")
  })

  test("6. read(.env) blocked by tool.execute.before; read(.env.example) allowed", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    await expect(
      hooks["tool.execute.before"]!({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: ".env" } } as never),
    ).rejects.toThrow(/Secret Broker blocked read/)
    await expect(
      hooks["tool.execute.before"]!(
        { tool: "read", sessionID: "s", callID: "c" },
        { args: { filePath: ".env.example" } } as never,
      ),
    ).resolves.toBeUndefined()
  })

  test("7. agent edit of .env.example mid-session does NOT expand injection", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    // Agent (or a compromised model) appends a new key it hopes to widen.
    writeFileSync(path.join(dir, ".env.example"), "CANARY_KEY=\nINJECTED_KEY=\n")
    writeFileSync(path.join(dir, ".env"), `CANARY_KEY=${CANARY}\nINJECTED_KEY=smuggled9999\n`)
    const output = { env: {} as Record<string, string> }
    await hooks["shell.env"]!({ cwd: dir }, output as never)
    expect(output.env.CANARY_KEY).toBe(CANARY)
    expect(output.env.INJECTED_KEY).toBeUndefined()
  })

  test("8. missing .env: shell.env injects nothing and after-hook leaves output unchanged", async () => {
    const dir = tmp()
    const hooks = await hooksFor(dir)
    const env = { env: {} as Record<string, string> }
    await hooks["shell.env"]!({ cwd: dir }, env as never)
    expect(env.env).toEqual({})

    const output = { title: "bash", output: "no secrets here", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output as never)
    expect(output.output).toBe("no secrets here")
    expect(output.metadata).toEqual({ exit: 0 })
  })

  test("9a. messages.transform redacts a canary planted in parts/metadata", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    const messages = [
      {
        info: { id: "m1", role: "assistant" as const },
        parts: [
          { type: "text" as const, text: `the key is ${CANARY}` },
          {
            type: "tool" as const,
            state: { status: "completed" as const, metadata: { output: `env=${CANARY}` } },
          },
        ],
        metadata: { note: encodeURIComponent(CANARY) },
      },
    ]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: messages as never })
    assertSanitized(JSON.stringify(messages), "messages.transform")
  })

  test("9b. messages.transform is fail-closed: a throwing redactor withholds the part", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    const part = { type: "tool", output: `raw ${CANARY}` }
    Object.defineProperty(part, "boom", {
      enumerable: true,
      get() {
        throw new Error("redactor boom")
      },
    })
    const messages = [{ info: { id: "m1", role: "assistant" }, parts: [part] }]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: messages as never })
    const projected = JSON.stringify(messages)
    for (const variant of encodings(CANARY)) expect(projected).not.toContain(variant)
    expect(projected).toContain(REDACTION_WITHHELD)
  })

  test("9c. messages.transform fail-closed covers the WHOLE message, not just parts", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    // Canary sits in `info` (a sibling of `parts`). The throwing accessor is
    // defined on `info` so any in-place walk throws while visiting it, AFTER
    // `parts` may already have been redacted — a partial result the old
    // parts-only fallback would leak `info`'s canary through.
    const info: Record<string, unknown> = { id: "m1", role: "assistant", note: CANARY }
    Object.defineProperty(info, "boom", {
      enumerable: true,
      get() {
        throw new Error("redactor boom")
      },
    })
    const messages = [{ info, parts: [{ type: "text", text: `key ${CANARY}` }] }]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: messages as never })
    const projected = JSON.stringify(messages)
    for (const variant of encodings(CANARY)) expect(projected).not.toContain(variant)
    expect(projected).toContain(REDACTION_WITHHELD)
  })

  test("10. non-allowlisted .env value: never injected, but redacted from `cat .env` output", async () => {
    const UNDECLARED = "ghp_UNDECL+ARED=9876543210zyxw"
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "CANARY_KEY=\n")
    writeFileSync(path.join(dir, ".env"), `CANARY_KEY=${CANARY}\nUNDECLARED_KEY=${UNDECLARED}\n`)
    const hooks = await hooksFor(dir)

    // The undeclared key must NOT reach the child environment.
    const env = { env: {} as Record<string, string> }
    await hooks["shell.env"]!({ cwd: dir }, env as never)
    expect(env.env.CANARY_KEY).toBe(CANARY)
    expect(env.env.UNDECLARED_KEY).toBeUndefined()

    // A `cat .env` dump echoed through a tool result must be redacted anyway.
    const output = { title: "bash", output: `CANARY_KEY=${CANARY}\nUNDECLARED_KEY=${UNDECLARED}\n`, metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output as never)
    const projected = JSON.stringify(output)
    for (const variant of encodings(UNDECLARED)) expect(projected, `leaked ${variant}`).not.toContain(variant)
    expect(projected).toContain("secret://project/UNDECLARED_KEY")
    assertSanitized(projected, "cat .env non-allowlisted")
  })

  test("diag: shellEnv hands the real secret to the child process only", async () => {
    const dir = seed()
    const broker = await SecretBroker.create(dir)
    // The process environment is the intended, non-model-visible channel.
    expect(broker.shellEnv()).toEqual({ CANARY_KEY: CANARY })
    // The model-visible redaction path never reproduces it.
    assertSanitized(broker.redact(`leak ${CANARY}`), "broker.redact")
  })

  test("11. `cat .env` through the bash tool is denied; `.env.example` is allowed", async () => {
    const dir = seed()
    const hooks = await hooksFor(dir)
    for (const command of ["cat .env", "head -n 3 .env", "base64 .env", "cat .env | base64"]) {
      await expect(
        hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } } as never),
        command,
      ).rejects.toThrow(/Secret Broker blocked bash/)
    }
    await expect(
      hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, {
        args: { command: "cat .env.example" },
      } as never),
    ).resolves.toBeUndefined()
    await expect(
      hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, {
        args: { command: "npm test" },
      } as never),
    ).resolves.toBeUndefined()
  })

  test("12. short (<minLength) secret is injected AND redacted across every sink", async () => {
    const SHORT = "sh0rt7"
    const dir = tmp()
    writeFileSync(path.join(dir, ".env.example"), "SHORT_KEY=\n")
    writeFileSync(path.join(dir, ".env"), `SHORT_KEY=${SHORT}\n`)
    const hooks = await hooksFor(dir)
    const HANDLE = "secret://project/SHORT_KEY"

    // Injected into the child environment.
    const env = { env: {} as Record<string, string> }
    await hooks["shell.env"]!({ cwd: dir }, env as never)
    expect(env.env.SHORT_KEY).toBe(SHORT)

    // Redacted in tool output (`printenv` / `cat .env` echo).
    const output = { title: "bash", output: `SHORT_KEY=${SHORT}`, metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output as never)
    expect(output.output).not.toContain(SHORT)
    expect(output.output).toContain(HANDLE)

    // Redacted in model messages.
    const messages = [{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: `key ${SHORT}` }] }]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: messages as never })
    expect(JSON.stringify(messages)).not.toContain(SHORT)
    expect(JSON.stringify(messages)).toContain(HANDLE)

    // Redacted across stream chunk boundaries. (The handle may itself be split
    // by the retain buffer, so only absence of the secret is asserted.)
    const stream = new StreamRedactor(new Redactor([{ key: "SHORT_KEY", value: SHORT }], 8))
    let released = ""
    for (const char of `key=${SHORT}`) released += stream.push(char)
    released += stream.flush()
    expect(released).not.toContain(SHORT)
  })
})
