const mermaidLanguages = new Set(["mermaid"])

export function isMermaidLanguage(className: string): boolean {
  const language = className.match(/language-([\w-]+)/)?.[1]?.toLowerCase()
  return !!language && mermaidLanguages.has(language)
}

export function isMermaidCodeElement(code: Element): boolean {
  return code instanceof HTMLElement && isMermaidLanguage(code.className)
}
