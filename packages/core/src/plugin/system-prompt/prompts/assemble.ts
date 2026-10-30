// Deterministic assembler: core.md + adapters/<model>.md + manifest.json -> <model>.txt
// Byte-identical output is a hard gate; the txt files stay the build input of
// record so a stale artifact can never silently change the served prompt.
import { resolve } from "path"

const DIR = import.meta.dir

async function parse(file: string) {
  const lines = (await Bun.file(file).text()).split("\n")
  const blocks: Record<string, string[]> = {}
  let current: string[] | undefined
  for (const line of lines) {
    const start = line.match(/^<!-- @block:(.+?) -->$/)
    if (start?.[1]) {
      current = []
      blocks[start[1]] = current
      continue
    }
    if (line === "<!-- @end -->") {
      current = undefined
      continue
    }
    current?.push(line)
  }
  return blocks
}

type Segment = { core: string } | { local: string }

const manifest: { targets: Record<string, { adapter: string; output: string; segments: Segment[] }> } = JSON.parse(
  await Bun.file(resolve(DIR, "manifest.json")).text(),
)
const core = await parse(resolve(DIR, "core.md"))

// `--write` regenerates the target txt from core+adapter (Phase 2: wording
// intentionally changed, so the previous txt is NOT the expected output).
// Default mode verifies the committed txt still matches the sources.
const write = process.argv.includes("--write")

let failures = 0
for (const [name, target] of Object.entries(manifest.targets)) {
  const adapter = await parse(resolve(DIR, target.adapter))
  const bytes = target.segments
    .flatMap((segment) => {
      const source = "core" in segment ? core : adapter
      const id = "core" in segment ? segment.core : segment.local
      const block = source[id]
      if (!block) throw new Error(`${name}: missing block "${id}"`)
      return block
    })
    .join("\n")
    .concat("\n")
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

  if (write) {
    await Bun.write(resolve(DIR, target.output), bytes)
    console.log(`${name}: WROTE ${bytes.split("\n").length - 1} lines sha256=${sha}`)
    continue
  }

  const got = bytes.split("\n")
  const expected = (await Bun.file(resolve(DIR, target.output)).text()).split("\n")
  const at = got.findIndex((line, i) => line !== expected[i])
  if (at === -1 && got.length === expected.length) {
    console.log(`${name}: IDENTICAL sha256=${sha}`)
  } else {
    failures++
    console.log(`${name}: DIFF at line ${at + 1} (got ${got.length} lines, expected ${expected.length})`)
    console.log(`  expected: ${JSON.stringify(expected[at])}`)
    console.log(`  got:      ${JSON.stringify(got[at])}`)
  }
}

if (failures > 0) process.exit(1)
