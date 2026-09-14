// Plugin entrypoint. `opencode.json` "plugin": ["opencode-secret-broker"]
// loads the `./server` export, which the host expects to be a
// `Plugin = (input, options) => Promise<Hooks>` (or a `{ server }` module).
export { default, secretBrokerPlugin } from "./index.js"
export type { SecretBrokerOptions } from "./index.js"
