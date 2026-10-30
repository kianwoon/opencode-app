// `.md` agents are `---\n<frontmatter>\n---\n<body>`: everything through the
// closing `---` AND its newline is frontmatter, and the BODY is the prompt.
const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

export const promptBody = (content: string) => content.replace(frontmatter, "")

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
