import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { PtyEnvironment } from "@/compat/pty-environment"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"

const bootstrapReplacement = InstanceStore.bootstrapNode.replace(InstanceBootstrap.node)
// MCP's local servers need the broker-backed shell.env, but MCP cannot import
// the plugin-backed provider directly (mcp -> instance-store -> project ->
// command -> mcp is an ESM cycle), so the leaf node is swapped here instead.
const ptyEnvironmentReplacement = PtyEnvironment.node.replace(PluginPtyEnvironment.node)

export function build<A, E>(root: LayerNode.Graph<A, E>, replacements: LayerNode.Replacements = []) {
  return AppNodeBuilder.build(root, replacements.concat([bootstrapReplacement, ptyEnvironmentReplacement]))
}

export * as AppNodeBuilderV1 from "./app-node-builder-v1"
