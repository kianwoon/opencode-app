// Context Firewall — deterministic authority-grant detection (plan §4).
//
// These regexes ARE the enforcement: they run over every untrusted part at
// `experimental.chat.messages.transform` and neutralise the text before it
// reaches the model. The provenance `trust` tag written by `tool.execute.after`
// is ADVISORY metadata used to select which parts to scan — it is not itself a
// lockout. Detection never relies on the LLM behaving securely: pure,
// case-insensitive regexes over raw text, no model in the loop. A match means
// the text is attempting to GRANT AUTHORITY (a new permission, secret access,
// DLP-off, destructive op, install approval, broker policy), which untrusted
// content may never do. Trusted content is never touched.

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

/** Collapses every whitespace run (spaces, tabs, NEWLINES) to one space.
 *  Used for DETECTION only: a directive split across lines — "ignore\nprevious
 *  instructions" — must be recognised as the single instruction it is. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ")
}

/** True if `text` attempts an authority grant. Newlines are treated as plain
 *  whitespace so line-split evasions cannot slip past the per-line view. */
export function isDirective(text: string): boolean {
  return DIRECTIVE_PATTERNS.some((pattern) => pattern.test(collapse(text)))
}

/** Neutralises an authority-grant part by prefixing the marker to EVERY
 *  non-empty line. Tradeoff: detection collapses whitespace (so a cross-line
 *  "ignore\nprevious instructions" matches), and on any match we mark all of
 *  the part rather than trying to re-map the collapsed hit back to source
 *  lines — simpler and strictly fail-safe (over-marking only withholds
 *  authority). Blank and already-neutralised lines are left unchanged, so the
 *  transform is idempotent. Returns a NEW string; never mutates trusted parts.
 *  Bounded: one collapse + one pass. */
export function neutralize(text: string): string {
  if (!isDirective(text)) return text
  const lines = text.split("\n")
  let changed = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim().length === 0) continue
    if (line.startsWith(NEUTRALIZED_PREFIX)) continue
    lines[index] = `${NEUTRALIZED_PREFIX}${line.trimStart()}`
    changed = true
  }
  return changed ? lines.join("\n") : text
}
