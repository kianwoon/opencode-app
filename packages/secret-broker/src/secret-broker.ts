// Standalone plugin entrypoint used by `opencode.json` "plugin": ["file://.../dist/secret-broker.js"].
// The host loads the default export as `Plugin = (input, options) => Promise<Hooks>`.
// Kept distinct from `server.ts` so the config entry and Settings→Plugins row
// display as `secret-broker` rather than the generic `server`.
export { default, secretBrokerPlugin } from "./index.js"
export type { SecretBrokerOptions } from "./index.js"
