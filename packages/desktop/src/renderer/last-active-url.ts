// Validation for the last-active URL persisted per desktop window.
//
// A stale or malformed stored URL must never be seeded into the router: a
// malformed `/server/<segment>/...` value makes `currentRoute` throw inside
// `requireServerKey`, and a URL that no longer resolves to an open tab leaves no
// tab selected, so the tab strip renders its first entry — the oldest
// (leftmost) tab — as if it were active. Rejected URLs fall back to "/", where
// the tab store restores the last-active tab from `tabs.recent`.
//
// The base64url helpers mirror `@/utils/session-route` locally to avoid a
// `@opencode-ai/core` dependency in the desktop package.

export function base64UrlEncode(value: string) {
  const bytes = new TextEncoder().encode(value)
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function base64UrlDecode(value: string) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function isServerSegment(segment: string | undefined) {
  if (!segment) return false
  try {
    return base64UrlEncode(base64UrlDecode(segment)) === segment
  } catch {
    return false
  }
}

export function isKnownRoute(value: string) {
  const [path] = value.split(/[?#]/)
  const parts = (path ?? "").split("/").filter(Boolean)
  if (parts.length === 0) return true
  if (parts[0] === "new-session") return new URLSearchParams(value.split("?")[1] ?? "").has("draftId")
  if (parts[0] === "server") return parts[2] === "session" && !!parts[3] && isServerSegment(parts[1])
  // Legacy directory route: /<dirBase64>/session/<id>
  return parts[1] === "session" && !!parts[2]
}
