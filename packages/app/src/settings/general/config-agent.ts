// The settings panels WRITE the legacy on-disk agent block (`Config.Patch.agent`,
// model as a "providerID/modelID" string) but they must READ the normalized
// `Config.Info` the server actually serves from /api/config: `agents` (plural)
// with model decoded to { providerID, model, variant? } and permissions as an
// ordered Permission.Ruleset array. This module is the single translation point,
// so no read site can drift back to the legacy key or shape.
export type Action = "allow" | "ask" | "deny"
export type PermissionRule = Action | Record<string, Action>
export type AgentBlock = {
  description?: string
  mode?: "subagent" | "primary" | "all"
  model?: string
  // Legacy sibling of `model`, not part of the string: the v1 normalizer drops a
  // "#variant" suffix in `model` ("omitted unsupported legacy model reference"),
  // so the variant has to travel in its own key to survive a rename.
  variant?: string
  // Reasoning effort for the agent's runs, independent of the model. Absent means
  // inherit; the panel clears it by writing "" (updateConfig deep-merges and
  // cannot delete a key), which the config loader reads as unset.
  effort?: string
  color?: string
  owned_tools?: string[]
  skills?: string[]
  capabilities?: string[]
  permission?: Record<string, PermissionRule>
  steps?: number
  temperature?: number
  top_p?: number
  hidden?: boolean
  // A rename copies the RESOLVED prompt/description/mode onto the new key, so
  // the moved block must carry them; `disable` is the tombstone left behind on
  // the old key (updateConfig deep-merges and cannot delete).
  prompt?: string
  disable?: boolean
}

// Mirrors normalizeAction in packages/core/src/v1/config/migrate.ts: the
// normalizer renames tool actions on the way in, so the read path renames them
// back to the legacy ids these panels speak. `write`/`patch`/`apply_patch` all
// fold into `edit` and cannot be told apart again.
const legacyAction = (action: string) => {
  if (action === "shell") return "bash"
  if (action === "subagent") return "task"
  return action
}

/**
 * The normalized agents map, keyed exactly as the write path keys it. Anything
 * absent or malformed yields {} so a panel read site never derefs undefined.
 */
export function readAgents(config: unknown): Record<string, AgentBlock> {
  const agents = asRecord(asRecord(config)?.agents)
  if (!agents) return {}
  return Object.fromEntries(Object.entries(agents).map(([name, value]) => [name, readAgent(value)]))
}

function readAgent(value: unknown): AgentBlock {
  const info = asRecord(value)
  if (!info) return {}
  // The v1 normalizer funnels unknown legacy keys (owned_tools, skills,
  // capabilities, temperature, top_p) and the old `options` bag into
  // request.body, which is the only place the normalized Info still carries them.
  // Anything else left in request.body stays uncoverable from the normalized info.
  const body = asRecord(asRecord(info.request)?.body) ?? {}
  const selection = readSelection(info.model)
  const model = selection?.model
  const variant = selection?.variant
  const color = typeof info.color === "string" ? info.color : undefined
  const permission = readRuleset(info.permissions)
  const owned_tools = readStrings(body.owned_tools)
  const skills = readStrings(body.skills)
  const capabilities = readStrings(body.capabilities)
  const temperature = readFinite(body.temperature)
  const top_p = readFinite(body.top_p)
  const description = info.description
  const mode = info.mode
  const steps = readFinite(info.steps)
  const hidden = info.hidden
  // An empty string is the panel's clear-to-inherit write, so it reads as unset.
  const effort = typeof info.effort === "string" && info.effort !== "" ? info.effort : undefined
  return {
    ...(typeof description === "string" ? { description } : {}),
    ...(mode === "subagent" || mode === "primary" || mode === "all" ? { mode } : {}),
    ...(model === undefined ? {} : { model }),
    ...(variant === undefined ? {} : { variant }),
    ...(effort === undefined ? {} : { effort }),
    ...(color === undefined ? {} : { color }),
    ...(owned_tools === undefined ? {} : { owned_tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(permission === undefined ? {} : { permission }),
    ...(steps === undefined ? {} : { steps }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(top_p === undefined ? {} : { top_p }),
    ...(hidden === undefined ? {} : { hidden: hidden === true }),
    // `disabled` is the normalized name of the legacy tombstone key.
    ...(info.disabled === true ? { disable: true } : {}),
  }
}

// ConfigModel.Selection decodes to the explicit struct; a document that was
// never normalized still passes through as the legacy string untouched.
function readSelection(value: unknown) {
  if (typeof value === "string") return { model: value, variant: undefined }
  const selection = asRecord(value)
  if (!selection) return
  const providerID = selection.providerID
  const model = selection.model
  if (typeof providerID !== "string" || typeof model !== "string" || !providerID || !model) return
  return {
    model: `${providerID}/${model}`,
    variant: typeof selection.variant === "string" ? selection.variant : undefined,
  }
}

/** Split a legacy "providerID/modelID[#variant]" model string. The model id may itself contain "/". */
export function parseModel(value: string | undefined) {
  if (!value) return
  const [reference] = value.split("#")
  const separator = reference.indexOf("/")
  if (separator <= 0 || separator === reference.length - 1) return
  return { providerID: reference.slice(0, separator), modelID: reference.slice(separator + 1) }
}

/**
 * The Model row displays the model the RUNTIME resolved for the agent, never a
 * client-side reconstruction: the server's `/api/agent` entry already carries the
 * effective model (an `.md` frontmatter model, an inherited default), so a stale
 * or empty config snapshot can no longer contradict what the agent actually runs.
 * The config string is the fallback for a config-only entry the runtime did not
 * resolve a model for. Returns a ModelKey so the catalog lookup stays one call.
 */
export function resolveDisplayModel(
  runtime: { providerID: string; modelID: string } | undefined,
  config: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (runtime?.providerID && runtime.modelID) {
    return { providerID: runtime.providerID, modelID: runtime.modelID }
  }
  return parseModel(config)
}

/**
 * The one write shape for both panels: the legacy `agent` key, ONE agent, and
 * only the keys the edited control changed. Never the block read back from the
 * normalized config — that reconstruction cannot carry `prompt`, the legacy
 * `tools` map, or unknown `request.body` extras, so restating it would erase
 * them. The server merges these keys field by field.
 */
export function agentPatch(name: string, patch: AgentBlock) {
  return { agent: { [name]: patch } }
}

/**
 * The canonical reasoning-effort tiers, mirroring EFFORTS in
 * packages/core/src/variant.ts. They are only the FALLBACK scale: whenever the
 * agent's configured model is known and declares variants, the control offers
 * that model's own scale instead (see modelEffortScale), because providers
 * disagree on their effort values.
 */
export const EFFORT_TIERS = ["low", "medium", "high"] as const

/** Select options for the effort control: inherit ("") first, then the scale, then any configured value the scale does not name. */
export function effortOptions(current: string | undefined, scale: readonly string[] = []): { effort: string }[] {
  const values: string[] = scale.length > 0 ? [...scale] : [...EFFORT_TIERS]
  if (current !== undefined && current !== "" && !values.includes(current)) values.push(current)
  return [{ effort: "" }, ...values.map((effort) => ({ effort }))]
}

/**
 * A model's own effort scale: the variant ids its catalog entry declares. This is
 * the same data the model picker's variant list reads. Effort is resolved through
 * the model's variants (ModelResolver.effortSelection), so these ids, not a global
 * tier list, are the values that model actually understands — providers disagree
 * on the scale (`low/high/max`, `none/minimal/low/medium/high/xhigh`, …).
 * An absent or empty list means no model-specific scale is known.
 */
export function modelEffortScale(variants: Record<string, unknown> | undefined): string[] {
  return variants ? Object.keys(variants) : []
}

/**
 * The value the Effort control shows. A declared frontmatter key wins the merge,
 * so the file is the truth there; otherwise `/api/agent` is authoritative because
 * it is the MERGED runtime Info. The served `/api/config` block only covers a
 * config-only agent the runtime list does not carry — it is a lossy serialized
 * view and must never override the runtime.
 */
export function effectiveEffort(input: {
  declared: boolean
  frontmatter?: string
  runtime?: string
  config?: string
}): string | undefined {
  if (input.declared) return input.frontmatter
  return input.runtime ?? input.config
}

/**
 * Which surface the Effort row shows. A per-key decision, not a per-agent one:
 * an md-backed agent whose frontmatter does NOT declare `effort` is config-owned
 * (the md document is merged over the config, so config fills every key the file
 * omits) and gets the live config Select. Only a DECLARED frontmatter key forces
 * the file write path, and only the browser — which cannot read agent files —
 * falls back to the hint. `declared` is undefined while the bridge read is in
 * flight, so no control is offered blind.
 */
export function effortSurface(input: {
  mdBacked: boolean
  bridge: boolean
  declared: boolean | undefined
}): "config" | "file" | "hint" | "loading" {
  if (!input.mdBacked) return "config"
  if (!input.bridge) return "hint"
  if (input.declared === undefined) return "loading"
  return input.declared ? "file" : "config"
}

// Permission.Ruleset is an ordered array of { action, resource, effect }, while
// the panel (and the patch contract) speaks the legacy per-tool map.
function readRuleset(value: unknown) {
  if (!Array.isArray(value)) return
  const rules = value.flatMap((rule) => {
    const entry = asRecord(rule)
    const effect = entry?.effect
    if (!entry || typeof entry.action !== "string" || !isAction(effect)) return []
    return [
      {
        action: legacyAction(entry.action),
        resource: typeof entry.resource === "string" ? entry.resource : "*",
        effect,
      },
    ]
  })
  if (rules.length === 0) return
  const grouped = new Map<string, { resource: string; effect: Action }[]>()
  for (const rule of rules) grouped.set(rule.action, [...(grouped.get(rule.action) ?? []), rule])
  return Object.fromEntries(
    [...grouped].map(([action, entries]) => {
      // A lone "*" rule is the canonical bare-action form setHow writes; anything
      // else needs the pattern map so the wildcard is still visible.
      if (entries.length === 1 && entries[0].resource === "*") return [action, entries[0].effect]
      return [action, Object.fromEntries(entries.map((entry) => [entry.resource, entry.effect]))]
    }),
  ) as Record<string, PermissionRule>
}

const isAction = (value: unknown): value is Action => value === "allow" || value === "ask" || value === "deny"

const asRecord = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const readStrings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined

const readFinite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
