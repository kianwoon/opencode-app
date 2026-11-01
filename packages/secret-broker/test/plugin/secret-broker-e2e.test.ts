// End-to-end attack suite for the Secret Broker, driven through the REAL v2
// plugin path.
//
// Threat model: an evil/compromised UPSTREAM LLM provider observes every token
// that reaches the model — tool output, tool errors, streamed chunks, and the
// final message transcript. It knows the plugin exists and will run every cheap
// deterministic transform (base64, URL-encode, JSON-escape, shell-quote) to
// reconstruct a secret from whatever leaks. The broker's guarantee is narrower
// but absolute: the only credential representation the model can ever SEE is a
// `secret://project/NAME` handle. Real secret bytes travel to the CHILD PROCESS
// environment only (shell create.before), never through the model-visible channel.
//
// Every test below registers `secretBrokerPlugin` through `fromPromise` (the
// adapter `PluginModule` uses for a `Plugin.define({ id, setup })` module) against
// `PluginHost.make`, then drives host services: `PluginHooks.trigger`,
// `Tool.snapshot().execute` and `Environment.spawner`. No plugin internals are
// called directly.
//
// Network exfiltration is explicitly out of scope (spec §17): shell env
// legitimately hands the secret to a child process, so a program the model wrote
// could POST it out; that is a sandbox/egress concern, not a broker regression.
// This suite proves the MODEL-VISIBLE channel only.

import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import * as path from "node:path"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { Environment } from "../../../core/src/environment/index"
import { open, type Harness } from "./harness"
import { REDACTION_WITHHELD } from "../../src/index"
import { Redactor, StreamRedactor } from "../../src/redactor"
import { Tool } from "../../../core/src/tool"

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

function seed(directory: string, canary = CANARY) {
  writeFileSync(path.join(directory, ".env.example"), "CANARY_KEY=\n")
  writeFileSync(path.join(directory, ".env"), `CANARY_KEY=${canary}\n`)
}

const harnesses: Harness[] = []
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close()
})

/** Registers the broker through the real v2 path in a seeded project. */
async function broker(canary = CANARY) {
  const harness = await open({ seed: (directory) => seed(directory, canary) })
  harnesses.push(harness)
  return harness
}

/** A direct (non-Code-Mode) probe tool, so `snapshot.execute` reaches it by name. */
const probe = (name: string, execute: (input: any) => Effect.Effect<any, any>) => ({
  name,
  description: `probe ${name}`,
  input: { type: "object", properties: {}, additionalProperties: true },
      options: { codemode: false },
  options: { codemode: false },
  execute,
})

const call = (name: string, input: unknown) => ({
  sessionID: "ses_e2e",
  agent: "build",
  messageID: "msg_e2e",
  call: { type: "tool-call" as const, id: `call_${name}_${Math.random().toString(16).slice(2)}`, name, input },
})

describe("secret-broker e2e — model-visible channel never carries the canary", () => {
  test("1. shell create.before injects into a REAL spawned child process", async () => {
    const harness = await broker()
    // Exactly the invocation object `Shell.create` builds and hands the hook
    // (packages/core/src/shell.ts:277), then exactly the spawn it performs
    // (shell.ts:311) — only the process bookkeeping differs.
    const invocation = {
      command: "printenv CANARY_KEY",
      cwd: harness.directory,
      timeout: 0,
      shell: "/bin/sh",
      env: {} as Record<string, string | undefined>,
    }
    await harness.trigger("shell", "create.before", invocation)
    expect(invocation.env.CANARY_KEY).toBe(CANARY)

    const printed = await harness.run(
      Effect.gen(function* () {
        const environment = yield* Environment.Service
        const handle = yield* environment.spawner.spawn(
          ChildProcess.make(invocation.shell, ["-lc", invocation.command], { env: invocation.env }),
        )
        return Array.from(yield* Stream.runCollect(handle.stdout.pipe(Stream.decodeText()))).join("")
      }),
    )
    // The child legitimately received the secret: the broker injects, it does not
    // sandbox. What matters is that the MODEL never sees this text unredacted (test 3).
    expect(printed).toContain(CANARY)
  })

  test("2. a protected-path tool call is BLOCKED before the tool runs", async () => {
    const harness = await broker()
    let ran = false
    await harness.addTool({
      name: "read",
      description: "probe read",
      input: { type: "object", properties: {}, additionalProperties: true },
      options: { codemode: false },
      execute: () =>
        Effect.sync(() => {
          ran = true
          return { content: [{ type: "text", text: "contents" }] }
        }),
    })

    const exit = await harness.executeExit(call("read", { filePath: ".env" }))
    expect(exit._tag).toBe("Failure")
    expect(ran, "the tool executor must never run for a denied call").toBe(false)
    expect(JSON.stringify(exit)).toContain("Secret Broker blocked read")

    // A template sibling is exempt: protection targets the real secret file.
    const allowed = await harness.execute(call("read", { filePath: ".env.example" }))
    expect(ran).toBe(true)
    expect(JSON.stringify(allowed)).toContain("contents")
  })

  test("3. printenv output echoed through REAL tool execution is redacted", async () => {
    const harness = await broker()
    const leaked = `PATH=/usr/bin\nCANARY_KEY=${CANARY}\nHOME=/root`
    await harness.addTool({
      name: "shell",
      description: "probe shell",
      input: { type: "object", properties: {}, additionalProperties: true },
      options: { codemode: false },
      execute: () =>
        Effect.succeed({
          content: [{ type: "text", text: leaked }],
          metadata: { stdout: leaked, exit: 0 },
        }),
    })
    const result = await harness.execute(call("shell", { command: "printenv" }))
    assertSanitized(JSON.stringify(result), "printenv dump")
  })

  test("4. base64 / url-encoded canary in output maps to the handle", async () => {
    const harness = await broker()
    const text = `b64=${Buffer.from(CANARY).toString("base64")} url=${encodeURIComponent(CANARY)}`
    await harness.addTool({
      name: "echo",
      description: "probe echo",
      input: { type: "object", properties: {}, additionalProperties: true },
      options: { codemode: false },
      execute: () => Effect.succeed({ content: [{ type: "text", text }] }),
    })
    const result = await harness.execute(call("echo", {}))
    assertSanitized(JSON.stringify(result), "encoded output")
  })

  test("5. a leaked file part (data URL) is redacted too", async () => {
    const harness = await broker()
    const uri = `data:text/plain;base64,${Buffer.from(`CANARY_KEY=${CANARY}`).toString("base64")}`
    await harness.addTool({
      name: "readimage",
      description: "probe readimage",
      input: { type: "object", properties: {}, additionalProperties: true },
      options: { codemode: false },
      execute: () =>
        Effect.succeed({
          content: [{ type: "file", uri, mime: "text/plain", name: `dump ${CANARY}` }],
        }),
    })
    const result = await harness.execute(call("readimage", {}))
    assertSanitized(JSON.stringify(result.content), "file part")
  })

  test("6. a failed tool's error text is redacted before it reaches the model", async () => {
    const harness = await broker()
    const defect = new Error(`wrapped ${CANARY}`)
    await harness.addTool({
      name: "boom",
      description: "probe boom",
      input: { type: "object", properties: {}, additionalProperties: true },
      options: { codemode: false },
      execute: () =>
        Effect.fail(new Tool.Error({ message: `Invalid credential ${CANARY}`, metadata: { stderr: CANARY }, error: defect })),
    })
    const exit = await harness.executeExit(call("boom", {}))
    expect(exit._tag).toBe("Failure")
    assertSanitized(JSON.stringify(exit), "tool error")
    // The nested defect (whose stack carries the raw text) is redacted in place.
    expect(defect.message).not.toContain(CANARY)
  })

  test("7. the model-visible transcript is redacted in place before every step", async () => {
    const harness = await broker()
    // Mirrors processor.ts interrupt marking + message-v2 projection: the raw
    // live output sits in tool-part metadata.output and would reach the model.
    const message = {
      info: { id: "m1", role: "assistant" as const },
      parts: [
        {
          type: "tool" as const,
          tool: "bash",
          callID: "c1",
          state: {
            status: "error" as const,
            error: `Tool execution aborted ${CANARY}`,
            metadata: { interrupted: true, output: `live ${CANARY} leak` },
            time: { start: 0, end: 1 },
          },
        },
      ],
    }
    const draft = {
      sessionID: "ses_e2e",
      model: {},
      options: {},
      system: [{ type: "text", text: `instructions ${CANARY}` }],
      messages: [message],
      agent: "build",
      tools: {},
    }
    await harness.trigger("session", "context", draft as never)
    assertSanitized(JSON.stringify(draft), "context request")
    // Object identity is preserved so downstream projection is unchanged.
    expect(draft.messages[0]).toBe(message)
  })

  test("8. compaction sees the same redacted request", async () => {
    const harness = await broker()
    const draft = {
      sessionID: "ses_e2e",
      model: {},
      options: {},
      system: [{ type: "text", text: `summary ${CANARY}` }],
      messages: [{ info: { id: "m1", role: "user" as const }, parts: [{ type: "text", text: `ask ${CANARY}` }] }],
      agent: "compaction",
      tools: {},
    }
    await harness.trigger("session", "compaction", draft as never)
    assertSanitized(JSON.stringify(draft), "compaction request")
  })

  test("9. canary split across 3 stream chunks never leaks a fragment", () => {
    const redactor = new Redactor([{ key: "CANARY_KEY", value: CANARY }], 8)
    const stream = new StreamRedactor(redactor)
    const third = Math.ceil(CANARY.length / 3)
    const chunks = [CANARY.slice(0, third), CANARY.slice(third, third * 2), CANARY.slice(third * 2)]
    let released = ""
    for (const chunk of chunks) released += stream.push(chunk)
    released += stream.flush()
    assertSanitized(released, "streamed chunks")
  })

  test("10. byte-by-byte streaming never leaks a fragment", () => {
    const redactor = new Redactor([{ key: "CANARY_KEY", value: CANARY }], 8)
    const stream = new StreamRedactor(redactor)
    let released = ""
    for (const char of CANARY) released += stream.push(char)
    released += stream.flush()
    assertSanitized(released, "byte-by-byte")
  })

  test("11. missing .env injects nothing and leaves output untouched", async () => {
    const harness = await open()
    harnesses.push(harness)
    const invocation = {
      command: "true",
      cwd: harness.directory,
      timeout: 0,
      shell: "/bin/sh",
      env: {} as Record<string, string | undefined>,
    }
    await harness.trigger("shell", "create.before", invocation)
    expect(invocation.env).toEqual({})

    await harness.addTool({
      name: "noop",
      description: "probe noop",
      input: { type: "object", properties: {}, additionalProperties: true },
      options: { codemode: false },
      execute: () => Effect.succeed({ content: [{ type: "text", text: "nothing to redact" }], metadata: { exit: 0 } }),
    })
    const result = await harness.execute(call("noop", {}))
    expect(JSON.stringify(result)).toContain("nothing to redact")
    expect(result.metadata).toEqual({ exit: 0 })
  })

  test("12. a redactor that throws withholds the tool output (fail-closed)", async () => {
    const harness = await broker()
    const metadata = {} as Record<string, unknown>
    Object.defineProperty(metadata, "boom", {
      enumerable: true,
      get() {
        throw new Error("redactor boom")
      },
    })
    await harness.addTool({
      name: "leak",
      description: "probe leak",
      input: { type: "object", properties: {}, additionalProperties: true },
      options: { codemode: false },
      execute: () => Effect.succeed({ content: [{ type: "text", text: `raw ${CANARY} leak` }], metadata }),
    })
    const result = await harness.execute(call("leak", {}))
    expect(JSON.stringify(result)).toContain(REDACTION_WITHHELD)
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })
})
