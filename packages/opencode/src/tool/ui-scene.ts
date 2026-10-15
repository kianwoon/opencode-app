/**
 * SCENE organ — the semantic world model every higher layer reads.
 *
 * CONTRACT: perception yields SEMANTICS a decider can be pointed at with a GOAL,
 * never a raw control list. Every mapping here is ROLE/GEOMETRY/CONTAINMENT
 * derived and site-agnostic: regions come from roles, depth/containment, geometry
 * clustering and the driver's own `in_web_content` flag; item identity from
 * role+label lineage; affordances from declared actions + role; and a
 * state-changing classification a read-only governor can forbid. No site, app or
 * address name is ever read.
 *
 * INVARIANT OWNED: a raw Observation maps to a Scene whose regions/items/texts
 * carry stable identity that survives snapshot/element-token churn, and whose
 * state-changing items are flagged; the mapping is pure and vocabulary-tolerant
 * (unknown roles degrade, never throw) with bounded output.
 * LIVE INSTANCE: a captured browser window separates its CHROME toolbar from the
 * page CONTENT and finds the page's vertical nav as a LIST of row items with
 * texts and typed affordances.
 * UNSEEN SHAPE: an in-app settings dialog (a DIALOG of toggles/radios that carry
 * no in_web_content flag) is classified from role+containment alone, and a
 * horizontally-arranged tab strip is read as a LIST — both with no loop change.
 */

import type { Element, Observation } from "./ui-eyes"

export interface SceneBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type Affordance = "activatable" | "typable" | "selectable" | "scrollable" | "readonly"
export type RegionKind = "chrome" | "content" | "list" | "toolbar" | "dialog" | "detail"

export interface SceneItem {
  readonly id: string
  readonly role: string
  readonly label: string
  readonly affordances: readonly Affordance[]
  readonly stateChanging: boolean
  readonly enabled: boolean
  readonly selected?: boolean
  readonly element: Element
}

export interface SceneText {
  readonly id: string
  readonly role: string
  readonly text: string
  /** Owning item id when nested in one, else the owning region id. */
  readonly owner: string
  readonly element: Element
}

export interface SceneRegion {
  readonly id: string
  readonly kind: RegionKind
  readonly role?: string
  readonly label?: string
  readonly bounds?: SceneBounds
  readonly itemIds: readonly string[]
  readonly textIds: readonly string[]
}

export interface Scene {
  readonly snapshot: string
  readonly regions: readonly SceneRegion[]
  readonly items: readonly SceneItem[]
  readonly texts: readonly SceneText[]
}

export interface SceneDiff {
  readonly appeared: readonly string[]
  readonly disappeared: readonly string[]
  readonly changed: readonly string[]
}

// Zone + kind constants: named so a comparison is never a bare case literal.
const CONTENT_ZONE = "content"
const CHROME_ZONE = "chrome"
const LIST_KIND: RegionKind = "list"

// VOCABULARY — the driver's own AX role names. Unknown roles are not in any set
// and therefore degrade to the generic residual region / readonly affordance.
const TEXT_ROLES = new Set([
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXSecureTextField",
  "AXComboBox",
])
const INTERACTIVE_ROLES = new Set([
  "AXButton",
  "AXLink",
  "AXPopUpButton",
  "AXMenuButton",
  "AXMenuItem",
  "AXCheckBox",
  "AXRadioButton",
  "AXTab",
  "AXDisclosureTriangle",
  "AXSlider",
  "AXIncrementor",
])
const SELECTABLE_ROLES = new Set([
  "AXCheckBox",
  "AXRadioButton",
  "AXToggle",
  "AXSwitch",
  "AXTab",
  "AXRow",
  "AXCell",
  "AXListItem",
  "AXListOption",
  "AXMenuItem",
  "AXDisclosureTriangle",
])
const STATE_CHANGING_ROLES = new Set(["AXCheckBox", "AXRadioButton", "AXToggle", "AXSwitch"])
const SCROLL_ROLES = new Set([
  "AXScrollArea",
  "AXScrollBar",
  "AXWebArea",
  "AXWebView",
  "AXList",
  "AXOutline",
  "AXTable",
  "AXTabGroup",
])
const CONTENT_ROOT_ROLES = new Set(["AXWebArea", "AXWebView", "AXWebContent"])
const DIALOG_ROLES = new Set(["AXDialog", "AXSheet", "AXWindowSheet", "AXPopover", "AXAlert", "AXMenu"])
const READONLY_ROLES = new Set(["AXStaticText", "AXImage", "AXHeading"])
// Containers that are structural, never row items in their own right.
const NON_ROW_ROLES = new Set([
  "AXWindow",
  "AXWebArea",
  "AXWebView",
  "AXTabGroup",
  "AXHelpTag",
  "AXScrollArea",
])

const X_TOL = 4
const Y_TOL = 4
const MAX_ROW_GAP = 220

// ---------------------------------------------------------------------------
// Affordances + state classification
// ---------------------------------------------------------------------------

/** Affordances typed from the element's DECLARED actions + role, never its text. */
export function affordancesOf(element: Element): readonly Affordance[] {
  const role = element.role ?? ""
  const actions = element.actions ?? []
  const out: Affordance[] = []
  if (TEXT_ROLES.has(role) || actions.includes("AXSetValue")) out.push("typable")
  if (INTERACTIVE_ROLES.has(role) || actions.includes("AXPress") || actions.includes("AXConfirm"))
    out.push("activatable")
  if (SELECTABLE_ROLES.has(role) || actions.includes("AXSelect")) out.push("selectable")
  if (SCROLL_ROLES.has(role)) out.push("scrollable")
  return out.length > 0 ? out : ["readonly"]
}

/**
 * A state-changing element is one whose activation MUTATES state (checkboxes,
 * radios, toggles, and selectable rows/options). A plain link/text navigates or
 * is inert and is therefore NOT state-changing — a read-only governor forbids
 * only the former.
 */
export function isStateChanging(element: Element): boolean {
  const role = element.role ?? ""
  if (STATE_CHANGING_ROLES.has(role)) return true
  return SELECTABLE_ROLES.has(role) && element.selected !== undefined
}

// ---------------------------------------------------------------------------
// Containment + identity
// ---------------------------------------------------------------------------

interface Tree {
  readonly parentOf: (element: Element) => Element | undefined
  readonly keyOf: (element: Element) => string
  readonly siblingsOf: (element: Element) => readonly Element[]
}

function buildTree(elements: readonly Element[]): Tree {
  const byIndex = new Map<number, Element>()
  for (const element of elements) if (element.element_index !== undefined) byIndex.set(element.element_index, element)
  const parentOf = (element: Element): Element | undefined => {
    const index = element.parent_index
    if (index === undefined) return undefined
    const parent = byIndex.get(index)
    return parent && parent !== element ? parent : undefined
  }
  const keyOf = (element: Element): string => {
    const parent = parentOf(element)
    return parent ? `i${parent.element_index}` : "root"
  }
  const children = new Map<string, Element[]>()
  for (const element of elements) {
    const key = keyOf(element)
    const bucket = children.get(key)
    if (bucket) bucket.push(element)
    else children.set(key, [element])
  }
  return { parentOf, keyOf, siblingsOf: (element) => children.get(keyOf(element)) ?? [] }
}

const hash = (value: string): string => {
  let h = 5381
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) | 0
  return `s${(h >>> 0).toString(36)}`
}

const lineageKey = (element: Element): string => `${element.role ?? ""}\u0000${element.label ?? ""}`

function identityOf(element: Element, tree: Tree): string {
  const chain: string[] = []
  let current: Element | undefined = element
  for (let depth = 0; current && depth < 64; depth++) {
    chain.unshift(lineageKey(current))
    current = tree.parentOf(current)
  }
  const self = lineageKey(element)
  let ordinal = 0
  for (const sibling of tree.siblingsOf(element)) {
    if (sibling === element) break
    if (lineageKey(sibling) === self) ordinal++
  }
  return hash(`${chain.join("\u0001")}\u0002${ordinal}`)
}

/**
 * Stable identity derived from role+label LINEAGE (the ancestor chain of
 * role+label plus a same-sibling ordinal). It deliberately excludes snapshot id,
 * element_token and element_index, so the same logical item observed under a new
 * snapshot resolves to the same id while genuinely different items stay distinct.
 */
export function sceneIdentity(element: Element, elements: readonly Element[]): string {
  return identityOf(element, buildTree(elements))
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const rectOf = (element: Element): SceneBounds | undefined => element.frame ?? element.bounds ?? undefined

const hasArea = (element: Element): boolean => {
  const rect = rectOf(element)
  return rect !== undefined && rect.width > 0 && rect.height > 0
}

const alignedX = (a: Element, b: Element): boolean => {
  const ra = rectOf(a)
  const rb = rectOf(b)
  return ra !== undefined && rb !== undefined && Math.abs(ra.x - rb.x) <= X_TOL
}

const alignedY = (a: Element, b: Element): boolean => {
  const ra = rectOf(a)
  const rb = rectOf(b)
  return ra !== undefined && rb !== undefined && Math.abs(ra.y - rb.y) <= Y_TOL
}

const verticalStep = (a: Element, b: Element): boolean => {
  const ra = rectOf(a)
  const rb = rectOf(b)
  return ra !== undefined && rb !== undefined && rb.y > ra.y && rb.y - ra.y <= MAX_ROW_GAP
}

const horizontalStep = (a: Element, b: Element): boolean => {
  const ra = rectOf(a)
  const rb = rectOf(b)
  return ra !== undefined && rb !== undefined && rb.x > ra.x
}

const byY = (a: Element, b: Element): number => (rectOf(a)?.y ?? 0) - (rectOf(b)?.y ?? 0)
const byX = (a: Element, b: Element): number => (rectOf(a)?.x ?? 0) - (rectOf(b)?.x ?? 0)

const unionBounds = (elements: readonly Element[]): SceneBounds | undefined => {
  const rects = elements.map(rectOf).filter((rect): rect is SceneBounds => rect !== undefined)
  if (rects.length === 0) return undefined
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

const rowLike = (element: Element): boolean => {
  const role = element.role ?? ""
  if (NON_ROW_ROLES.has(role) || READONLY_ROLES.has(role)) return false
  if (!hasArea(element)) return false
  return (element.label ?? "").length > 0
}

const interactive = (element: Element): boolean => {
  const affordances = affordancesOf(element)
  return affordances.includes("activatable") || affordances.includes("typable")
}

const isContentZone = (zone: string | undefined): boolean => zone === CONTENT_ZONE
const isChromeZone = (zone: string | undefined): boolean => zone === CHROME_ZONE
const zoneOfGroup = (members: readonly Element[], zone: ReadonlyMap<Element, string>): string | undefined => {
  const first = members[0]
  return first === undefined ? undefined : zone.get(first)
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

interface RegionDraft {
  kind: RegionKind
  members: Element[]
}

function zoneOf(element: Element, tree: Tree): string {
  if (element.in_web_content === true) return CONTENT_ZONE
  let current = tree.parentOf(element)
  for (let depth = 0; current && depth < 64; depth++) {
    if (CONTENT_ROOT_ROLES.has(current.role ?? "")) return CONTENT_ZONE
    current = tree.parentOf(current)
  }
  return CHROME_ZONE
}

/** Maximal runs of same-role, aligned, monotonically-stacked siblings (>= 2). */
function listRuns(members: readonly Element[], content: boolean): Element[][] {
  const runs: Element[][] = []
  const byRole = new Map<string, Element[]>()
  for (const element of members) {
    if (!rowLike(element)) continue
    const role = element.role ?? ""
    const bucket = byRole.get(role)
    if (bucket) bucket.push(element)
    else byRole.set(role, [element])
  }
  for (const items of byRole.values()) {
    let run: Element[] = []
    for (const element of [...items].sort(byY)) {
      const previous = run.at(-1)
      if (previous && alignedX(previous, element) && verticalStep(previous, element)) run.push(element)
      else {
        if (run.length >= 2) runs.push(run)
        run = [element]
      }
    }
    if (run.length >= 2) runs.push(run)
    if (!content) continue
    // A horizontally-arranged strip of same-role controls (a tab/segment strip)
    // is also a list of row items.
    let horizontal: Element[] = []
    for (const element of [...items].sort(byX)) {
      const previous = horizontal.at(-1)
      if (previous && alignedY(previous, element) && horizontalStep(previous, element)) horizontal.push(element)
      else {
        if (horizontal.length >= 2) runs.push(horizontal)
        horizontal = [element]
      }
    }
    if (horizontal.length >= 2) runs.push(horizontal)
  }
  return runs
}

/** The widest horizontal row of interactive siblings, if any — a toolbar. */
function toolbarRun(members: readonly Element[]): Element[] | undefined {
  const rows = new Map<number, Element[]>()
  for (const element of members) {
    if (!interactive(element) || !hasArea(element)) continue
    const rect = rectOf(element)
    if (rect === undefined) continue
    const bucket = Math.round(rect.y / Y_TOL)
    const row = rows.get(bucket)
    if (row) row.push(element)
    else rows.set(bucket, [element])
  }
  let best: Element[] | undefined
  let bestSpan = 0
  for (const row of rows.values()) {
    if (row.length < 2) continue
    const rects = row.map(rectOf).filter((rect): rect is SceneBounds => rect !== undefined)
    const span = Math.max(...rects.map((r) => r.x)) - Math.min(...rects.map((r) => r.x))
    if (span <= 0) continue
    if (span > bestSpan) {
      bestSpan = span
      best = row
    }
  }
  return best
}

export function buildScene(observation: Observation): Scene {
  const elements = observation.elements
  const tree = buildTree(elements)
  const zone = new Map<Element, string>()
  for (const element of elements) zone.set(element, zoneOf(element, tree))

  const assigned = new Set<Element>()
  const drafts: RegionDraft[] = []
  const push = (kind: RegionKind, members: Element[]): void => {
    for (const member of members) assigned.add(member)
    drafts.push({ kind, members })
  }

  // DIALOGS: role-named containers (site-agnostic) own their whole subtree.
  for (const element of elements) {
    if (!DIALOG_ROLES.has(element.role ?? "") || assigned.has(element)) continue
    const members = elements.filter((candidate) => {
      if (assigned.has(candidate)) return false
      let current: Element | undefined = candidate
      for (let depth = 0; current && depth < 64; depth++) {
        if (current === element) return true
        current = tree.parentOf(current)
      }
      return false
    })
    if (members.length > 0) push("dialog", members)
  }

  // LISTS + TOOLBARS: per containment group, so sibling geometry is comparable.
  const groups = new Map<string, Element[]>()
  for (const element of elements) {
    const key = tree.keyOf(element)
    const bucket = groups.get(key)
    if (bucket) bucket.push(element)
    else groups.set(key, [element])
  }
  for (const group of groups.values()) {
    const free = group.filter((element) => !assigned.has(element))
    for (const run of listRuns(free, isContentZone(zoneOfGroup(free, zone)))) push(LIST_KIND, run)
    const remaining = group.filter((element) => !assigned.has(element))
    if (remaining.length > 0 && isChromeZone(zoneOfGroup(remaining, zone))) {
      const toolbar = toolbarRun(remaining)
      if (toolbar) push("toolbar", toolbar)
    }
  }

  // RESIDUAL: everything left, grouped by (zone, containment). A read-only
  // content group is a DETAIL pane; interactive content is the page CONTENT.
  const residual = new Map<string, Element[]>()
  for (const element of elements) {
    if (assigned.has(element)) continue
    const key = `${zone.get(element)}:${tree.keyOf(element)}`
    const bucket = residual.get(key)
    if (bucket) bucket.push(element)
    else residual.set(key, [element])
  }
  for (const members of residual.values()) {
    const content = isContentZone(zoneOfGroup(members, zone))
    const readonly = members.every((element) => affordancesOf(element).includes("readonly"))
    push(content ? (readonly ? "detail" : "content") : "chrome", members)
  }

  // Items: row items of LIST regions, plus every state-changing control (a
  // governor target) wherever it sits.
  const itemElements = new Set<Element>()
  for (const draft of drafts) {
    if (draft.kind !== LIST_KIND) continue
    for (const member of draft.members) if (rowLike(member)) itemElements.add(member)
  }
  for (const element of elements) if (isStateChanging(element)) itemElements.add(element)

  const items: SceneItem[] = [...itemElements].map((element) => ({
    id: identityOf(element, tree),
    role: element.role ?? "",
    label: element.label ?? "",
    affordances: affordancesOf(element),
    stateChanging: isStateChanging(element),
    enabled: element.enabled !== false,
    ...(element.selected !== undefined ? { selected: element.selected } : {}),
    element,
  }))
  const itemById = new Map(items.map((item) => [item.id, item]))

  // Region id per member element, so a text can name its owning region.
  const regionId = new Map<Element, string>()
  const regions: SceneRegion[] = []
  drafts.forEach((draft, index) => {
    const id = `r${index}:${draft.kind}`
    for (const member of draft.members) regionId.set(member, id)
    const first = draft.members[0]
    const labelled = draft.members.find((member) => member.label)
    const bounds = unionBounds(draft.members)
    regions.push({
      id,
      kind: draft.kind,
      ...(first?.role !== undefined ? { role: first.role } : {}),
      ...(labelled?.label !== undefined ? { label: labelled.label } : {}),
      ...(bounds !== undefined ? { bounds } : {}),
      itemIds: [],
      textIds: [],
    })
  })

  // Texts: readable content elements (static text / heading / a carried value),
  // owned by the nearest ancestor item, else their region.
  const textElements = elements.filter(
    (element) =>
      !itemElements.has(element) &&
      (READONLY_ROLES.has(element.role ?? "") || element.value !== undefined),
  )
  const ownerOf = (element: Element): string | undefined => {
    let current = tree.parentOf(element)
    for (let depth = 0; current && depth < 64; depth++) {
      const candidate = itemById.get(identityOf(current, tree))
      if (candidate) return candidate.id
      current = tree.parentOf(current)
    }
    return regionId.get(element)
  }
  const texts: SceneText[] = textElements.map((element) => ({
    id: identityOf(element, tree),
    role: element.role ?? "",
    text: element.value ?? element.label ?? "",
    owner: ownerOf(element) ?? "scene",
    element,
  }))

  const itemIdsByRegion = new Map<string, string[]>()
  for (const element of itemElements) {
    const id = regionId.get(element)
    if (id === undefined) continue
    const bucket = itemIdsByRegion.get(id)
    if (bucket) bucket.push(identityOf(element, tree))
    else itemIdsByRegion.set(id, [identityOf(element, tree)])
  }
  const textIdsByRegion = new Map<string, string[]>()
  for (const text of texts) {
    if (itemById.has(text.owner)) continue
    const id = regionId.get(text.element)
    if (id === undefined) continue
    const bucket = textIdsByRegion.get(id)
    if (bucket) bucket.push(text.id)
    else textIdsByRegion.set(id, [text.id])
  }
  const withIds = regions.map((region) => ({
    ...region,
    itemIds: itemIdsByRegion.get(region.id) ?? [],
    textIds: textIdsByRegion.get(region.id) ?? [],
  }))

  return { snapshot: observation.snapshot_id, regions: withIds, items, texts }
}

const itemFingerprint = (item: SceneItem): string =>
  `${item.role}|${item.label}|${item.affordances.join(",")}|${item.stateChanging}|${item.enabled}|${item.selected}|${item.element.value ?? ""}`

const textFingerprint = (text: SceneText): string => `${text.role}|${text.text}`

function fingerprintMap(scene: Scene): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of scene.items) map.set(item.id, itemFingerprint(item))
  for (const text of scene.texts) map.set(text.id, textFingerprint(text))
  return map
}

/**
 * Diff two consecutive Scenes by STABLE identity: `appeared`/`disappeared` are
 * id-set differences and `changed` is the same id whose fingerprint moved (a
 * toggled selection, a flipped enabled, a value edit) — never a positional diff.
 */
export function diffScene(previous: Scene, next: Scene): SceneDiff {
  const before = fingerprintMap(previous)
  const after = fingerprintMap(next)
  const appeared: string[] = []
  const disappeared: string[] = []
  const changed: string[] = []
  for (const [id, fingerprint] of after) {
    const prior = before.get(id)
    if (prior === undefined) appeared.push(id)
    else if (prior !== fingerprint) changed.push(id)
  }
  for (const id of before.keys()) if (!after.has(id)) disappeared.push(id)
  return { appeared, disappeared, changed }
}
