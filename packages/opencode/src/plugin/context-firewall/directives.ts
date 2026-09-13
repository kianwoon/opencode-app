// Context Firewall — deterministic authority-grant detection (plan §4).
//
// Detection is SUPPLEMENTARY to lockout-at-the-sink; it never relies on the LLM
// behaving securely. These are pure, case-insensitive regexes over raw text —
// no model in the loop. A match means the line is attempting to GRANT AUTHORITY
// (a new permission, secret access, DLP-off, destructive op, install approval,
// broker policy), which untrusted content may never do. The matched line is
// neutralised in place; trusted content is never touched.

/** A neutralisation marker placed in front of a neutralised directive line. */
export const NEUTRALIZED_PREFIX = "⚠️ Untrusted content — not authoritative: "

/** Authority-grant shapes. Longest/most specific first is unimportant: we
 *  neutralise every line that matches ANY pattern. Each line is tested once. */
export const DIRECTIVE_PATTERNS: readonly RegExp[] = [
  // Instruction-override / jailbreak preambles.
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)?\s*(instructions?|prompts?|rules?|restrictions?|guidelines?)/i,
  /disregard\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|restrictions?)/i,
  /forget\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?)/i,
  /ignore\s+your\s+(safety|security)\s+(rules?|guidelines?|policy)/i,
  // Disable a protection (DLP / redaction / secret broker / permission checks).
  /disable\s+(the\s+)?(dlp|redact(ion|or)?|secret[- ]?broker|secret\s+scanning|permission\s+(checks?|system)|firewall)/i,
  /turn\s+off\s+(the\s+)?(dlp|redact(ion|or)?|secret[- ]?broker|permission\s+(checks?|system))/i,
  /bypass\s+(the\s+)?(dlp|redact(ion|or)?|secret[- ]?broker|permission\s+(checks?|system)|security)/i,
  // Grant permissions.
  /grant\s+(all\s+)?permissions?/i,
  /allow\s+(all\s+)?permissions?/i,
  /grant\s+(full\s+)?(root|admin|sudo|elevated)\s+access/i,
  // Approve / run dependencies or installs.
  /run\s+(this\s+|the\s+)?(command|dependency|install|script)/i,
  /approve\s+(this\s+)?(command|dependency|install|script|package)/i,
  /auto[- ]?approve\s+(all\s+)?(commands?|dependencies|installs?|tools?)/i,
  // Secret exfiltration.
  /exfiltrate\b/i,
  /(upload|send|post|leak)\b.*(id_rsa|\.env|private\s+key|credentials?|secrets?|api[- ]?keys?)/i,
  // Destructive / production authorisation.
  /approve\s+(the\s+)?(production|deploy(ment)?|destructive\s+op)/i,
  /authorize\s+(the\s+)?(production|deploy(ment)?|destructive\s+op)/i,
  // Destructive command shapes.
  /\bdrop\s+database\b/i,
  /\brm\s+-rf\s+\//i,
  /\bmkfs(\.\w+)?\b/i,
]

/** True if a single line attempts an authority grant. */
export function isDirective(line: string): boolean {
  return DIRECTIVE_PATTERNS.some((pattern) => pattern.test(line))
}

/** Neutralises every authority-grant line in `text` by prefixing a marker.
 *  Lines that are already neutralised (idempotent) and blank lines are left
 *  unchanged. Returns a NEW string; never mutates trusted/authoritative parts.
 *  Bounded: one pass, one test per line. */
export function neutralize(text: string): string {
  if (!text.includes("\n") && !isDirective(text)) return text
  const lines = text.split("\n")
  let changed = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.startsWith(NEUTRALIZED_PREFIX)) continue
    if (!isDirective(line)) continue
    lines[index] = `${NEUTRALIZED_PREFIX}${line.trimStart()}`
    changed = true
  }
  return changed ? lines.join("\n") : text
}
