import { Npm } from "@opencode/util/npm"
import { Effect, Layer } from "effect"

export const noop = Layer.mock(Npm.Service)({
  add: (pkg) => Effect.succeed({ directory: pkg, name: pkg }),
})

export * as NpmTest from "./npm"
