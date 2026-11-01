// `.md` agents are `---\n<frontmatter>\n---\n<body>`: everything through the
// closing `---` AND its newline is frontmatter, and the BODY is the prompt.
const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/
const frontmatterInner = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export const promptBody = (content: string) => content.replace(frontmatter, "")

export type FrontmatterValue = { declared: boolean; value?: string }

/**
 * Read one key out of the `.md` frontmatter. `declared` records PRESENCE, not
 * truthiness: the loader applies a frontmatter key whenever it is present and the
 * md document is merged over the config, so an empty `effort:` still owns the
 * setting and a config write to it would be dead.
 */
export function readFrontmatterValue(content: string, key: string): FrontmatterValue {
  const inner = content.match(frontmatterInner)?.[1]
  if (inner === undefined) return { declared: false }
  const line = new RegExp(`^${key}\\s*:\\s*(.*)$`)
  for (const entry of inner.split(/\r?\n/)) {
    const match = line.exec(entry)
    if (!match) continue
    const value = match[1]
      .trim()
      .replace(/\s+#.*$/u, "")
      .replace(/^(['"])(.*)\1$/u, "$2")
    return { declared: true, ...(value === "" ? {} : { value }) }
  }
  return { declared: false }
}

/**
 * Set (or delete, with `undefined`) one frontmatter key in place. The body and
 * every other key stay byte-for-byte, the same contract as writePromptBody: a
 * key the file declares cannot be written through the config API, so this is the
 * only live write path for it.
 */
export async function writeFrontmatterValue(
  bridge: {
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
  },
  path: string,
  key: string,
  value: string | undefined,
) {
  const current = await bridge.readFile(path)
  const eol = current.includes("\r\n") ? "\r\n" : "\n"
  const match = current.match(frontmatterInner)
  const inner = match ? match[1] : ""
  const body = match ? current.slice(match[0].length) : current
  const line = new RegExp(`^${key}\\s*:`)
  const kept = inner.split(/\r?\n/).filter((entry) => !line.test(entry))
  if (value !== undefined && value !== "") kept.push(`${key}: ${value}`)
  while (kept.length > 0 && kept[0].trim() === "") kept.shift()
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop()
  await bridge.writeFile(path, `---${eol}${kept.map((entry) => entry + eol).join("")}---${eol}${body}`)
  return value
}

/**
 * Prompt-row precedence: a just-saved body wins, then the `.md` body on disk,
 * then the server's cached value. A config or native agent has no file, so it
 * keeps the server value and never reaches a file read.
 */
export const resolvePrompt = (input: { override?: string; file?: string; server: string }) =>
  input.override ?? input.file ?? input.server

/**
 * A save touches ONLY the `.md`, and the bridge is deliberately read/write only:
 * a `PATCH /config` makes `Config.updateGlobal` dispose every instance, killing
 * the very run that clicked Save, so no config write may be issued from here.
 */
export const writePromptBody = async (
  bridge: {
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
  },
  path: string,
  body: string,
) => {
  const current = await bridge.readFile(path)
  await bridge.writeFile(path, (current.match(frontmatter)?.[0] ?? "") + body)
  return body
}
