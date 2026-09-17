import { describe, expect, test } from "bun:test"
import { base64UrlEncode, isKnownRoute, isServerSegment } from "./last-active-url"

// Matches `ServerConnection.Key.make("local\nhttp://localhost:4096")`.
const serverKey = "local\nhttp://localhost:4096"
const serverSegment = base64UrlEncode(serverKey)

describe("isKnownRoute", () => {
  test("accepts the home route", () => {
    expect(isKnownRoute("/")).toBe(true)
  })

  test("accepts a server-scoped session route", () => {
    expect(isKnownRoute(`/server/${serverSegment}/session/ses_123`)).toBe(true)
  })

  test("accepts a draft route with a draftId", () => {
    expect(isKnownRoute("/new-session?draftId=abc")).toBe(true)
  })

  test("accepts a legacy directory session route", () => {
    expect(isKnownRoute(`/${base64UrlEncode("/repo")}/session/ses_123`)).toBe(true)
  })

  test("rejects a server route with a malformed segment", () => {
    // `requireServerKey` throws on this, so it must never be seeded.
    expect(isKnownRoute("/server/!!!not-base64!!!/session/ses_123")).toBe(false)
    expect(isKnownRoute("/server//session/ses_123")).toBe(false)
  })

  test("rejects a server route missing its session id", () => {
    expect(isKnownRoute(`/server/${serverSegment}/session`)).toBe(false)
    expect(isKnownRoute(`/server/${serverSegment}/project/p1`)).toBe(false)
  })

  test("rejects a draft route without a draftId", () => {
    expect(isKnownRoute("/new-session")).toBe(false)
  })

  test("rejects a directory route missing its session id", () => {
    expect(isKnownRoute(`/${base64UrlEncode("/repo")}/session`)).toBe(false)
    expect(isKnownRoute("/single-segment")).toBe(false)
  })
})

describe("isServerSegment", () => {
  test("round-trips a canonical server key", () => {
    expect(isServerSegment(serverSegment)).toBe(true)
  })

  test("rejects non-canonical and invalid segments", () => {
    expect(isServerSegment(undefined)).toBe(false)
    expect(isServerSegment("")).toBe(false)
    expect(isServerSegment(`${serverSegment}=`)).toBe(false)
    expect(isServerSegment("###")).toBe(false)
  })
})
