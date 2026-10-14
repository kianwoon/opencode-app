import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { parseHTML } from "linkedom"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import {
  Parameters,
  cdpPort,
  extractScript,
  isBravePayload,
  searchURL,
  sourceHost,
  sourcePath,
} from "../../src/tool/bravelookup"

// The browser path (the native Bun-WebSocket CDP transport) is LIVE-SMOKE-VERIFIED
// ONLY — it needs a live Brave process and the network, so it has no unit test
// here. These tests cover the pure surface — URL builder, CDP port resolution,
// the Brave-payload verifier, source-host derivation, the parameter schema, and
// the generated extraction script. The extraction tests run the REAL script against
// fixture SERPs parsed by a real DOM implementation (linkedom, which supports
// `innerText` natively), so a query-specific branch (e.g. `if (q.includes("weather"))`)
// would be caught behaviorally — not just by source identity.

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

const toJsonSchema = ToolJsonSchema.fromSchema

// Run the REAL extraction script against a fixture SERP parsed by linkedom.
const extract = (query: string, body: string, title = "Result") => {
  const { document } = parseHTML(`<html><head><title>${title}</title></head><body>${body}</body></html>`)
  return JSON.parse(new Function("document", `return ${extractScript(query)}`)(document))
}

describe("bravelookup", () => {
  describe("searchURL", () => {
    test("builds the SERP url with hl=en", () => {
      expect(searchURL("weather in paris")).toBe("https://www.google.com/search?q=weather%20in%20paris&hl=en")
    })

    test("encodes reserved characters in the query", () => {
      expect(searchURL("a&b=c d")).toBe("https://www.google.com/search?q=a%26b%3Dc%20d&hl=en")
    })

    test("keeps the query verbatim after decoding", () => {
      const query = 'tomato "price" €/kg?'
      const url = new URL(searchURL(query))
      expect(url.searchParams.get("q")).toBe(query)
      expect(url.searchParams.get("hl")).toBe("en")
    })
  })

  describe("cdpPort", () => {
    test("defaults to 9333 (not Electron's 9222)", () => {
      expect(cdpPort({})).toBe("9333")
    })

    test("honours OPENCODE_BRAVE_CDP_PORT", () => {
      expect(cdpPort({ OPENCODE_BRAVE_CDP_PORT: "9222" })).toBe("9222")
    })
  })

  describe("isBravePayload", () => {
    test("accepts the real Brave /json/version payload captured live", () => {
      expect(
        isBravePayload({
          Browser: "Chrome/155.0.8059.40",
          "Protocol-Version": "1.3",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
          "webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/browser/0981ab15-ef84-48ba-b46d-30d06ca90cf7",
        }),
      ).toBe(true)
    })

    test("rejects the OpenCode/Electron payload observed on 9222 at runtime", () => {
      expect(
        isBravePayload({
          Browser: "Chrome/148.0.7778.218",
          "Protocol-Version": "1.3",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OpenCode/1.19.0 Chrome/148.0.7778.218 Electron/42.3.3 Safari/537.36",
          "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/dadab26a-6ea6-4853-93bf-617cb354c980",
        }),
      ).toBe(false)
    })

    test("rejects a HeadlessChrome payload", () => {
      expect(
        isBravePayload({
          Browser: "HeadlessChrome/131.0.0.0",
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
        }),
      ).toBe(false)
    })

    test("rejects a payload with no Browser field", () => {
      expect(isBravePayload({ "Protocol-Version": "1.3" })).toBe(false)
      expect(isBravePayload({ Browser: "" })).toBe(false)
      expect(isBravePayload(null)).toBe(false)
    })
  })

  describe("sourceHost", () => {
    test("drops a leading www and keeps the host", () => {
      expect(sourceHost("https://www.accuweather.com/en/paris")).toBe("accuweather.com")
    })

    test("falls back to google.com without a host", () => {
      expect(sourceHost("about:blank")).toBe("google.com")
      expect(sourceHost("")).toBe("google.com")
    })
  })

  describe("sourcePath", () => {
    test("returns host + path for the provenance marker", () => {
      expect(sourcePath("https://www.google.com/search?q=x")).toBe("google.com/search")
      expect(sourcePath("https://www.accuweather.com/en/paris")).toBe("accuweather.com/en/paris")
    })
  })

  describe("extractScript", () => {
    test("injects the query as a JS string literal and leaves no placeholder", () => {
      const script = extractScript('a "quote" and \\ backslash')
      expect(script).toContain(JSON.stringify('a "quote" and \\ backslash'))
      expect(script).not.toContain("__QUERY__")
    })

    test("produces valid JavaScript for any query", () => {
      expect(() => new Function(extractScript("who won the match yesterday"))).not.toThrow()
      expect(() => new Function(extractScript("hasła"))).not.toThrow()
    })

    test("ports the general algorithm, not query-specific cases", () => {
      const script = extractScript("anything")
      // wall strings
      expect(script).toContain("unusual traffic")
      expect(script).toContain("confirm you're not a robot")
      // density anchor + relation test
      expect(script).toContain("relationApplied")
      expect(script).toContain("relationPassed")
      expect(script).toContain("(s|es|ed|ing)?")
      // price-token detector
      expect(script).toContain("priceRe")
      expect(script).toContain("hasPrice")
      // F6: esc char class is the exact Swift class — no redundant `\$`
      expect(script).toContain("[.*+?^${}()|[\\]\\\\]")
    })

    test("is identical across queries apart from the injected query", () => {
      const a = extractScript("weather in paris")
      const b = extractScript("bitcoin price usd")
      expect(a.replace(JSON.stringify("weather in paris"), "")).toBe(
        b.replace(JSON.stringify("bitcoin price usd"), ""),
      )
    })
  })

  describe("extraction (behavioral, linkedom DOM)", () => {
    test("extracts the densest query-relevant region for a weather query", () => {
      const r = extract(
        "weather in paris",
        "All News Images Maps Books Search tools Weather in Paris tonight: 18C. Paris weather forecast: partly cloudy, 64% humidity, wind 12 km/h. Weather in Paris tomorrow will be sunny with a high of 22C. The Paris weather outlook for the next 10 days shows mild conditions. Weather Paris hourly details follow.",
      )
      expect(r.relationApplied).toBe(true)
      expect(r.relationPassed).toBe(true)
      expect(r.answer).toContain("18C")
    })

    test("extracts a different query type (price) with the same algorithm", () => {
      const r = extract(
        "singapore to tokyo flight price",
        "Flights Singapore to Tokyo: the cheapest flight price we found is SGD 512 round trip. Flight price for Singapore Tokyo varies by date. Compare Singapore to Tokyo flight prices across airlines; this price is for a round trip.",
      )
      expect(r.answer.length).toBeGreaterThan(0)
      expect(r.hasPrice).toBe(true)
      expect(r.priceSample).toContain("SGD512")
    })

    test("yields no answer when the query's terms do not appear (nav chrome)", () => {
      const r = extract("zxqwv nonsense", "All News Images Maps Books Search tools Settings Sign in Feedback")
      expect(r.relationApplied).toBe(true)
      expect(r.relationPassed).toBe(false)
      expect(r.answer).toBe("")
    })

    test("reports a consent/wall page as blocked", () => {
      const r = extract("anything", "Before you continue to Google Search: please accept cookies.")
      expect(r.blocked).toBe(true)
      expect(r.answer).toBe("")
    })
  })

  describe("parameters", () => {
    test("json schema (wire shape)", () => expect(toJsonSchema(Parameters)).toMatchSnapshot())

    test("accepts a query", () => {
      expect(parse(Parameters, { query: "weather in paris" })).toEqual({ query: "weather in paris" })
    })

    test("rejects a missing query", () => {
      expect(accepts(Parameters, {})).toBe(false)
    })

    test("rejects a non-string query", () => {
      expect(accepts(Parameters, { query: 1 })).toBe(false)
    })
  })
})
