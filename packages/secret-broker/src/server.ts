// Plugin entrypoint. `opencode.json` "plugin": ["opencode-secret-broker"]
// loads the `./server` export, whose default must be a v2 plugin definition
// (`Plugin.define({ id, setup })`) — the shape `PluginModule` decodes.
export { default, secretBrokerPlugin } from "./index.js"
export type { SecretBrokerOptions } from "./index.js"
