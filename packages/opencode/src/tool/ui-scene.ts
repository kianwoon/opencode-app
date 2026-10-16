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
import { hasScrollActions } from "./ui-hands"

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
  /**
   * THE SURFACE'S OWN NAME — the window label the observation carries ("About",
   * "Accessibility"). A pane's identity lives HERE, not in its content text, so an
   * arrival check that searches content reports "not arrived" while the loop is
   * already sitting on the target surface. Absent when the observation carries no
   * window element (the arrival verdict is then `unknown`, never a fabricated true).
   */
  readonly window?: string
  /**
   * THE RENDERED TREE — the driver's `tree_markdown`, carrying the UNNUMBERED
   * static-text nodes a pane displays (labels beside their values) that the addressable
   * element array omits. A read binds its attribute through the LABEL line here when no
   * addressable element carries it. Absent when the observation carried no markdown.
   */
  readonly treeText?: string
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
  // SCROLLABILITY BY ACTION, NOT ROLE: an element declaring AXScrollToVisible/Top/
  // Bottom scrolls even with no scroll-area role.
  if (SCROLL_ROLES.has(role) || hasScrollActions(element)) out.push("scrollable")
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

/** This element's ordinal among preceding siblings that share its role+label lineage. */
function ordinalOf(element: Element, tree: Tree): number {
  const self = lineageKey(element)
  let ordinal = 0
  for (const sibling of tree.siblingsOf(element)) {
    if (sibling === element) break
    if (lineageKey(sibling) === self) ordinal++
  }
  return ordinal
}

function identityOf(element: Element, tree: Tree): string {
  const chain: string[] = []
  let current: Element | undefined = element
  for (let depth = 0; current && depth < 64; depth++) {
    // Each ancestor contributes its OWN ordinal, so two same-shaped sibling
    // containers produce DISTINCT identities for the descendants inside each.
    chain.unshift(`${lineageKey(current)}\u0002${ordinalOf(current, tree)}`)
    current = tree.parentOf(current)
  }
  return hash(chain.join("\u0001"))
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

// A readable text cell a row exposes (name/date/preview), never an image control.
const TEXT_CELL_ROLES = new Set(["AXStaticText", "AXHeading", "AXLink", "AXTextField", "AXTextArea"])
const CONTAINER_WIDTH_TOL = 24

/** Whether `candidate` sits anywhere under `ancestor` (exclusive of itself). */
const isDescendantOf = (candidate: Element, ancestor: Element, tree: Tree): boolean => {
  let current = tree.parentOf(candidate)
  for (let depth = 0; current && depth < 64; depth++) {
    if (current === ancestor) return true
    current = tree.parentOf(current)
  }
  return false
}

/** The readable text a container-built row exposes: its own text/name/preview cells joined. */
function containerText(element: Element, elements: readonly Element[], tree: Tree): string {
  const cells: string[] = []
  for (const candidate of elements) {
    if (candidate === element || candidate.element_index === element.element_index) continue
    if (!isDescendantOf(candidate, element, tree)) continue
    if (!(TEXT_CELL_ROLES.has(candidate.role ?? "") || candidate.value !== undefined)) continue
    const text = candidate.value ?? candidate.label ?? ""
    if (text.length > 0) cells.push(text)
  }
  return cells.join(" ")
}

/**
 * A LABEL-LESS ROW's own label: the first labelled descendant it contains (e.g. a
 * sidebar `AXRow` whose text lives on a child button). Purely structural — the row's
 * identity is unchanged, only its exposed label is recovered.
 */
function descendantLabel(element: Element, elements: readonly Element[], tree: Tree): string | undefined {
  const found = elements.find(
    (candidate) =>
      candidate !== element &&
      isDescendantOf(candidate, element, tree) &&
      (candidate.value ?? candidate.label ?? "").length > 0,
  )
  return found === undefined ? undefined : (found.value ?? found.label ?? "")
}

/**
 * CONTAINER-BUILT ROWS — a list whose children carry no ROW role (a web app builds
 * its rows from generic containers, so `AXRow` never appears). Recognised
 * STRUCTURALLY, never by role or name: repeated siblings under the SAME parent
 * (same depth), aligned left edge, similar width, stacked vertically, each owning
 * its own text cells. The invariant: item structure is inferred from
 * containment/repetition/geometry, so it holds for any framework's markup.
 * UNSEEN SHAPE COVERED: a card grid built from `div`s with no list/row roles.
 */
function containerRuns(members: readonly Element[], elements: readonly Element[]): Element[][] {
  const parents = new Set<number>()
  for (const element of elements) if (element.parent_index !== undefined) parents.add(element.parent_index)
  const byRole = new Map<string, Element[]>()
  for (const element of members) {
    if (rowLike(element) || !hasArea(element)) continue
    if (element.element_index === undefined || !parents.has(element.element_index)) continue
    const role = element.role ?? ""
    const bucket = byRole.get(role)
    if (bucket) bucket.push(element)
    else byRole.set(role, [element])
  }
  const runs: Element[][] = []
  for (const items of byRole.values()) {
    let run: Element[] = []
    for (const element of [...items].sort(byY)) {
      const previous = run.at(-1)
      const ra = previous ? rectOf(previous) : undefined
      const rb = rectOf(element)
      const similarWidth =
        ra !== undefined && rb !== undefined && Math.abs(ra.width - rb.width) <= CONTAINER_WIDTH_TOL
      if (previous && alignedX(previous, element) && similarWidth && verticalStep(previous, element)) run.push(element)
      else {
        if (run.length >= 2) runs.push(run)
        run = [element]
      }
    }
    if (run.length >= 2) runs.push(run)
  }
  return runs
}

// A container whose role DECLARES a list owns its children as the list's rows —
// the structural signal that a group's children are row CELLS, not unrelated siblings.
const LIST_PARENT_ROLES = new Set(["AXList", "AXOutline", "AXTable", "AXTree"])
const BAND_COLUMN_TOL = 24

/** Distinct left-edge columns in a cluster (>= 2 means the cells sit side-by-side). */
function columnCount(members: readonly Element[]): number {
  const xs = members.map((element) => rectOf(element)?.x).filter((x): x is number => x !== undefined).sort((a, b) => a - b)
  let columns = 0
  let previous: number | undefined
  for (const x of xs) {
    if (previous === undefined || x - previous > BAND_COLUMN_TOL) columns++
    previous = x
  }
  return columns
}

/** The readable text a ROW exposes: its text/name/preview cells joined in reading order. */
const rowText = (members: readonly Element[]): string =>
  [...members]
    .sort((a, b) => byY(a, b) || byX(a, b))
    .filter((element) => TEXT_CELL_ROLES.has(element.role ?? "") || element.value !== undefined)
    .map((element) => element.value ?? element.label ?? "")
    .filter((text) => text.length > 0)
    .join(" ")

/**
 * FLAT ROW-BUILT ROWS — a list whose children carry no ROW role and are NOT wrapped
 * in per-row containers (a web app emits every row's cells flat under the list).
 * Recognised STRUCTURALLY from geometry alone: siblings whose frames overlap
 * vertically form a horizontal BAND, and a band spanning >= 2 columns (side-by-side
 * cells: avatar/name/date/preview) that REPEATS down the list is a row. The
 * invariant: item structure is inferred from containment/repetition/geometry, so it
 * holds for any framework's markup — a nested-container list and a flat cell list
 * both reduce to rows. UNSEEN SHAPE COVERED: a table/grid emitting header+cell
 * static texts flat with no row roles.
 */
function multiColumnBands(members: readonly Element[]): Element[][] {
  const framed = members.filter(hasArea).sort(byY)
  const clusters: Element[][] = []
  let current: Element[] = []
  let bottom = -Infinity
  for (const element of framed) {
    const rect = rectOf(element)
    if (rect === undefined) continue
    // A band is a maximal run of cells whose vertical extents touch/overlap.
    if (current.length === 0 || rect.y < bottom) {
      current.push(element)
      bottom = Math.max(bottom, rect.y + rect.height)
    } else {
      clusters.push(current)
      current = [element]
      bottom = rect.y + rect.height
    }
  }
  if (current.length > 0) clusters.push(current)
  return clusters.filter((cluster) => columnCount(cluster) >= 2)
}

const coverageOf = (groups: readonly (readonly Element[])[]): number =>
  groups.reduce((total, group) => total + group.length, 0)

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
  // Elements recognised as container-built rows (no row role) — they become items.
  const containerItems = new Set<Element>()
  // Flat row-built lists: the representative element of each row band, its
  // synthesized label, and the row-cell → item-id ownership the band imposes.
  const bandItems = new Set<Element>()
  const bandMember = new Set<Element>()
  const bandLabels = new Map<Element, string>()
  const bandOwner = new Map<Element, string>()
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
    // A container whose role DECLARES a list owns its children as rows: try to
    // recover rows from FLAT sibling cells (no per-row container, no row role).
    const parentIndex = free[0]?.parent_index
    const parent = parentIndex === undefined ? undefined : elements.find((element) => element.element_index === parentIndex)
    const rows = parent !== undefined && LIST_PARENT_ROLES.has(parent.role ?? "") ? multiColumnBands(free) : []
    const runs = listRuns(free, isContentZone(zoneOfGroup(free, zone)))
    if (rows.length >= 2 && coverageOf(rows) > coverageOf(runs)) {
      const members: Element[] = []
      for (const band of rows) {
        const representative =
          band
            .filter((element) => (element.label ?? "").length > 0)
            .sort((a, b) => byY(a, b) || byX(a, b))[0] ?? band[0]
        if (representative === undefined) continue
        const id = identityOf(representative, tree)
        bandItems.add(representative)
        const bandText = rowText(band)
        // Only a non-empty band text overrides the row's own label — an unlabelled
        // row (its text carried by a descendant control) keeps the descendant fallback.
        if (bandText.length > 0) bandLabels.set(representative, bandText)
        for (const member of band) {
          members.push(member)
          bandMember.add(member)
          if (member !== representative && (TEXT_CELL_ROLES.has(member.role ?? "") || member.value !== undefined))
            bandOwner.set(member, id)
        }
      }
      if (bandItems.size > 0) push(LIST_KIND, members)
    } else {
      for (const run of runs) push(LIST_KIND, run)
      // STRUCTURAL rows: any remaining repeated sibling CONTAINERS with no row role
      // still become list items.
      const structural = group.filter((element) => !assigned.has(element))
      for (const run of containerRuns(structural, elements)) {
        for (const member of run) containerItems.add(member)
        push(LIST_KIND, run)
      }
    }
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
    for (const member of draft.members) {
      // A row band IS the item: its non-representative cells are not separate items
      // (state-changing cells are still re-added below as governor targets).
      if (bandMember.has(member) && !bandItems.has(member)) continue
      if (rowLike(member) || containerItems.has(member) || bandItems.has(member)) itemElements.add(member)
    }
  }
  for (const element of elements) if (isStateChanging(element)) itemElements.add(element)

  // An item's exposed label: a flat row band's text, else the container's own text
  // cells, else the row's own label, else — a label-less row whose text lives on a
  // descendant control (a sidebar `AXRow` carrying a labelled child button) — the
  // first labelled descendant. Purely structural; item identity is unchanged.
  const rowLabelOf = (element: Element): string => {
    const band = bandLabels.get(element)
    if (band !== undefined) return band
    const container = containerItems.has(element) ? containerText(element, elements, tree) : ""
    if (container.length > 0) return container
    return (element.label ?? "").length > 0 ? (element.label ?? "") : (descendantLabel(element, elements, tree) ?? "")
  }

  const items: SceneItem[] = [...itemElements].map((element) => ({
    id: identityOf(element, tree),
    role: element.role ?? "",
    label: rowLabelOf(element),
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
    // A flat row band forces ownership: a cell's text belongs to its band's item.
    const band = bandOwner.get(element)
    if (band !== undefined) return band
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

  // SURFACE IDENTITY: the window element's own label names the surface on screen.
  // Read from the observation, never assumed; absent when the payload omits it.
  const window = elements
    .map((element) => (element.role === "AXWindow" ? (element.label ?? "").trim() : ""))
    .find((label) => label.length > 0)
  return {
    snapshot: observation.snapshot_id,
    regions: withIds,
    items,
    texts,
    ...(window !== undefined ? { window } : {}),
    ...(observation.text !== undefined ? { treeText: observation.text } : {}),
  }
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
