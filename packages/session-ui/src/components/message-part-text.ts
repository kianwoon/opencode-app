export function readPartText(part: { text?: string }): string {
  return (part.text ?? "").trim()
}
