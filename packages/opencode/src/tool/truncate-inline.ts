// Pure, synchronous line/byte truncation shared by the main-thread path
// (tool/truncate.ts) and the CPU worker pool (tool/cpu-pool.worker.ts). Keeping
// one implementation means a pool result and an inline result cannot disagree.
export interface TruncateReduction {
  /** Preview text after the head/tail walk. */
  readonly content: string
  /** Bytes omitted from the original text. */
  readonly removedBytes: number
  /** Whole lines omitted from the original text. */
  readonly removedLines: number
  /** True when the walk stopped on the byte cap rather than the line cap. */
  readonly hitBytes: boolean
}

/**
 * Walks `text` from head or tail collecting whole lines until either cap is hit.
 * Byte accounting uses Buffer.byteLength so multibyte content is measured the
 * same way the caller's marker is.
 */
export function truncateInline(text: string, maxLines: number, maxBytes: number, direction: "head" | "tail"): TruncateReduction {
  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  if (direction === "head") {
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const line = lines[i] ?? ""
      const size = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.push(line)
      bytes += size
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const line = lines[i] ?? ""
      const size = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.unshift(line)
      bytes += size
    }
  }
  const removedBytes = Buffer.byteLength(text, "utf-8") - bytes
  const omittedLines = lines.length - out.length
  return {
    content: out.join("\n"),
    removedBytes,
    removedLines: omittedLines,
    hitBytes,
  }
}
