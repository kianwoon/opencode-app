const mermaidLanguages = new Set(["mermaid"])

export function isMermaidLanguage(className: string): boolean {
  const language = className.match(/language-([\w-]+)/)?.[1]?.toLowerCase()
  return !!language && mermaidLanguages.has(language)
}

export function isMermaidCodeElement(code: Element): boolean {
  if (!(code instanceof HTMLElement)) return false
  if (isMermaidLanguage(code.className)) return true
  return code.parentElement?.getAttribute("data-language")?.toLowerCase() === "mermaid"
}
