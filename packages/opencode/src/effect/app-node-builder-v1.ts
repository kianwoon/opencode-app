import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PtyEnvironment } from "@opencode-ai/server/pty-environment"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"

const bootstrapReplacement = [InstanceStore.bootstrapNode, InstanceBootstrap.node] as const
// MCP's local servers need the broker-backed shell.env, but MCP cannot import
// the plugin-backed provider directly (mcp -> instance-store -> project ->
// command -> mcp is an ESM cycle), so the leaf node is swapped here instead.
const ptyEnvironmentReplacement = [PtyEnvironment.node, PluginPtyEnvironment.node] as const

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  return AppNodeBuilder.build(root, replacements.concat([bootstrapReplacement, ptyEnvironmentReplacement]))
}

export * as AppNodeBuilderV1 from "./app-node-builder-v1"
