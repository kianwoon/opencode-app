import type { SessionMessage } from "@opencode-ai/sdk/v2/types"
import type { Hooks } from "./registration.js"

/**
 * Per-request chat messages transform domain.
 *
 * Unlike the state-backed domains (skill, reference), this is a one-shot,
 * in-flight transform of the messages assembled for the current provider turn.
 * Plugins register a transform callback that receives the mutable draft array;
 * they prune/truncate it in place (tool outputs, reasoning, assistant text) so
 * the request stays within budget. Cache-aware plugins mutate deterministically
 * (same message → same output every step) so the provider KV-cache prefix is
 * not invalidated between steps.
 */
export type MessagesDraft = SessionMessage[]

export type MessagesHooks = Hooks<{
  transform: MessagesDraft
}>
