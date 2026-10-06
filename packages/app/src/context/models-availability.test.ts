import { describe, expect, test } from "bun:test"
import { type AvailableModel, unavailableEntries, alternativeModel } from "./models"

const catalog = (...models: AvailableModel[]) => models

const entry = (providerID: string, modelID: string) => ({ providerID, modelID, visibility: "show" as const })

const available = (providerID: string, modelID: string): AvailableModel => ({
  id: modelID,
  provider: { id: providerID },
})

describe("unavailableEntries", () => {
  test("returns stored entries whose provider+model left the catalog", () => {
    const stored = [entry("opencode-go", "space-bunny-free"), entry("opencode", "space-bunny-free")]

    expect(unavailableEntries(stored, catalog(available("opencode", "space-bunny-free")))).toEqual([
      entry("opencode-go", "space-bunny-free"),
    ])
  })

  test("keeps an entry available when the same provider still serves a different model", () => {
    const stored = [entry("opencode-go", "dropped")]

    expect(unavailableEntries(stored, catalog(available("opencode-go", "other")))).toEqual(stored)
  })

  test("returns nothing when every stored entry is still served", () => {
    const stored = [entry("opencode", "a"), entry("anthropic", "b")]

    expect(unavailableEntries(stored, catalog(available("opencode", "a"), available("anthropic", "b")))).toEqual([])
  })

  test("returns nothing for an empty store or empty catalog", () => {
    expect(unavailableEntries([], catalog(available("opencode", "a")))).toEqual([])
    expect(unavailableEntries([entry("opencode", "a")], [])).toEqual([entry("opencode", "a")])
  })
})

describe("alternativeModel", () => {
  test("finds the same model id served by another provider", () => {
    const result = alternativeModel(
      { providerID: "opencode-go", modelID: "space-bunny-free" },
      catalog(available("opencode", "space-bunny-free")),
    )

    expect(result).toEqual({ providerID: "opencode", modelID: "space-bunny-free" })
  })

  test("is deterministic: candidates sort by provider id", () => {
    const result = alternativeModel(
      { providerID: "opencode-go", modelID: "space-bunny-free" },
      catalog(
        available("zeta", "space-bunny-free"),
        available("alpha", "space-bunny-free"),
        available("opencode", "space-bunny-free"),
      ),
    )

    expect(result).toEqual({ providerID: "alpha", modelID: "space-bunny-free" })
  })

  test("never resolves to the originating provider", () => {
    const result = alternativeModel(
      { providerID: "opencode", modelID: "a" },
      catalog(available("opencode", "a"), available("anthropic", "a")),
    )

    expect(result).toEqual({ providerID: "anthropic", modelID: "a" })
  })

  test("returns undefined when no provider still serves the model id", () => {
    expect(alternativeModel({ providerID: "opencode-go", modelID: "gone" }, catalog(available("opencode", "a")))).toBe(
      undefined,
    )
  })
})
