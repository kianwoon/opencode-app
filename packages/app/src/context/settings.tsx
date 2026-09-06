import { createStore, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"
import { usePlatform } from "@/context/platform"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
    followup: "queue" | "steer"
    showFileTree: boolean
    showNavigation: boolean
    showSearch: boolean
    showStatus: boolean
    showTerminal: boolean
    showReasoningSummaries: boolean
    shellToolPartsExpanded: boolean
    editToolPartsExpanded: boolean
    showCustomAgents: boolean
    mobileTitlebarPosition: "top" | "bottom"
    newLayoutDesigns?: boolean
    layoutTransitionEligible?: boolean
    agentVisibilityInitialized?: boolean
    newInterfaceNoticeDismissed?: boolean
    shouldDisplayTabsToast?: boolean
  }
  appearance: {
    fontSize: number
    mono: string
    sans: string
    terminal: string
    uiFontWeight: number
    codeFontWeight: number
    terminalFontWeight: number
    uiFontColorLight: string
    uiFontColorDark: string
    codeFontColorLight: string
    codeFontColorDark: string
    terminalFontColorLight: string
    terminalFontColorDark: string
    message: string
    messageWidth: number
    messageAlign: "left" | "center" | "right"
    messageBorderWidth: number
    messageBorderColorLight: string
    messageBorderColorDark: string
    messageBackgroundLight: string
    messageBackgroundDark: string
    messageFontWeight: number
    messageFontColorLight: string
    messageFontColorDark: string
    userMessageTextColorLight: string
    userMessageTextColorDark: string
    userMessageFont: string
    userMessageFontWeight: number
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"
export const messageDefault = "System Sans"
const legacyNewLayoutDesignsDefault = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"
export const newLayoutDesignsDefault = true
// Existing users can switch layouts until local midnight on this date. Set new Date(YYYY, M-1, D) to show.
export const oldInterfaceSunset = new Date(2026, 8, 14)
const newLayoutDesignsUpgradeCutoff = "1.17.19"

function compareVersions(a: string, b: string) {
  const parse = (version: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i.exec(version.trim())
    if (!match) return
    return match.slice(1).map(Number)
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return
  const index = left.findIndex((part, index) => part !== right[index])
  return index === -1 ? 0 : left[index]! - right[index]!
}

export function isAppUpgrade(previous: string | undefined, current: string | undefined) {
  if (!previous || !current) return false
  const comparison = compareVersions(current, previous)
  return comparison !== undefined && comparison > 0
}

export function shouldDisplayTabsToast(
  previous: string | undefined,
  current: string | undefined,
  existingInstall: boolean,
) {
  return isAppUpgrade(previous, current) || (!previous && existingInstall)
}

export function hasExistingWebState(settings: Promise<string> | string | null, previousVersion: string | undefined) {
  return settings !== null || previousVersion !== undefined
}

export function initialAgentVisibility(initialized: boolean | undefined, existing: boolean, previousVersion?: string) {
  if (initialized === true) return
  return existing || previousVersion !== undefined
}

export function shouldEnableNewLayout(previous: string | undefined, current: string | undefined) {
  if (!current) return false
  const currentComparison = compareVersions(current, newLayoutDesignsUpgradeCutoff)
  if (!previous) return currentComparison !== undefined && currentComparison > 0
  if (!isAppUpgrade(previous, current)) return false
  const previousComparison = compareVersions(previous, newLayoutDesignsUpgradeCutoff)
  return (
    previousComparison !== undefined &&
    currentComparison !== undefined &&
    previousComparison <= 0 &&
    currentComparison > 0
  )
}

export function layoutTransitionState(scheduled: boolean, eligible: boolean, retired: boolean, dismissed: boolean) {
  return {
    available: scheduled && eligible && !retired,
    notice: scheduled && eligible && retired && !dismissed,
  }
}

export const maximumSunsetTimeout = 2_147_483_647

export function nextSunsetCheckDelay(sunset: number, now: number) {
  return Math.min(Math.max(0, sunset - now), maximumSunsetTimeout)
}

export function resolveNewLayoutDesigns(retired: boolean, preference: boolean | undefined, fallback = true) {
  if (retired) return true
  return preference ?? fallback
}

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

// macOS installs many per-weight fonts (IBM Plex, SF Mono, etc.) as separate
// families: "IBM Plex Mono Light" is its own family and `font-weight: 300` on
// "IBM Plex Mono" does NOT select it. To honor the weight control for those
// fonts we prepend weight-qualified family names to the stack; the browser
// matches the first one that exists and otherwise falls back to the base
// family with the requested `font-weight` (variable fonts still work).
const WEIGHT_FAMILY_SUFFIXES: Record<number, string[]> = {
  100: ["Thin", "UltraLight"],
  200: ["ExtraLight", "Extra Light"],
  300: ["Light"],
  400: ["Regular", "Book"],
  500: ["Medium"],
  600: ["SemiBold", "Semi-Bold", "DemiBold", "Semibold"],
  700: ["Bold"],
  800: ["ExtraBold", "Extra Bold", "Heavy"],
  900: ["Black", "Heavy"],
}

export function weightFamilyNames(font: string, weightValue: number) {
  const base = font.trim()
  if (!base) return []
  const suffixes = WEIGHT_FAMILY_SUFFIXES[weightValue]
  if (!suffixes || weightValue === 400) return []
  return suffixes.map((suffix) => `${base} ${suffix}`)
}

function stack(font: string | undefined, base: string, weightValue?: number) {
  const value = font?.trim() ?? ""
  if (!value) return base
  const weighted = weightFamilyNames(value, weightValue ?? 400)
  if (!weighted.length) return `${family(value)}, ${base}`
  return `${weighted.map(family).join(", ")}, ${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined, weightValue?: number) {
  return stack(font, monoBase, weightValue)
}

export function sansFontFamily(font: string | undefined, weightValue?: number) {
  return stack(font, sansBase, weightValue)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined, weightValue?: number) {
  return stack(font, terminalBase, weightValue)
}

export function messageFontFamily(font: string | undefined, weightValue?: number) {
  return stack(font, sansBase, weightValue)
}

export function weight(weight: number | undefined, fallback: number) {
  return weight ?? fallback
}

export function color(color: string | undefined) {
  const value = color?.trim()
  return value ? value : ""
}

// Builds a CSS value for a font color override, resolved per color scheme.
// When both values are empty we return the empty string so consumers fall back
// to the themed text color instead of overriding it. When only one scheme has
// a value, that color applies to both schemes (the settings UI pairs the two
// fields so users normally set both).
export function fontColor(light: string | undefined, dark: string | undefined) {
  const lightValue = color(light)
  const darkValue = color(dark)
  if (!lightValue && !darkValue) return ""
  if (lightValue && darkValue) return `light-dark(${lightValue}, ${darkValue})`
  return lightValue || darkValue
}

export const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
    followup: "steer",
    showFileTree: false,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: false,
    showReasoningSummaries: false,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showCustomAgents: false,
    mobileTitlebarPosition: "top",
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
    uiFontWeight: 400,
    codeFontWeight: 400,
    terminalFontWeight: 400,
    uiFontColorLight: "",
    uiFontColorDark: "",
    codeFontColorLight: "",
    codeFontColorDark: "",
    terminalFontColorLight: "",
    terminalFontColorDark: "",
    message: "",
    messageWidth: 64,
    messageAlign: "right",
    messageBorderWidth: 0,
    messageBorderColorLight: "",
    messageBorderColorDark: "",
    messageBackgroundLight: "",
    messageBackgroundDark: "",
    messageFontWeight: 400,
    messageFontColorLight: "",
    messageFontColorDark: "",
    userMessageTextColorLight: "",
    userMessageTextColorDark: "",
    userMessageFont: "",
    userMessageFontWeight: 400,
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const [store, setStore, settingsInit, ready] = persisted("settings.v3", createStore<Settings>(defaultSettings))
    const [launch, setLaunch, , launchReady] = persisted(
      "app-version.v1",
      createStore<{ version?: string }>({ version: undefined }),
    )
    const [launchState, setLaunchState] = createStore({
      classified: false,
      migrationApplied: false,
      previous: undefined as string | undefined,
    })
    const showFileTree = withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree)
    const showSearch = withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch)
    const showStatus = withFallback(() => store.general?.showStatus, defaultSettings.general.showStatus)
    const showCustomAgents = withFallback(
      () => store.general?.showCustomAgents,
      defaultSettings.general.showCustomAgents,
    )
    const sunset = oldInterfaceSunset
    const [oldInterfaceRetired, setOldInterfaceRetired] = createSignal(sunset ? Date.now() >= sunset.getTime() : false)
    const layoutTransitionClassified = createMemo(() => typeof store.general?.layoutTransitionEligible === "boolean")
    const layoutTransitionEligible = withFallback(() => store.general?.layoutTransitionEligible, false)
    const newInterfaceNoticeDismissed = withFallback(() => store.general?.newInterfaceNoticeDismissed, false)
    const layoutUpgrade = createMemo(() =>
      launchState.classified && !launchState.migrationApplied
        ? shouldEnableNewLayout(launchState.previous, platform.version)
        : false,
    )
    const layoutTransition = createMemo(() =>
      layoutTransitionState(!!sunset, layoutTransitionEligible(), oldInterfaceRetired(), newInterfaceNoticeDismissed()),
    )
    const newLayoutDesigns = createMemo(() => {
      if (layoutUpgrade()) return true
      if (!ready() && !oldInterfaceRetired()) return legacyNewLayoutDesignsDefault
      if (!layoutTransitionClassified()) {
        return resolveNewLayoutDesigns(
          oldInterfaceRetired(),
          store.general?.newLayoutDesigns,
          legacyNewLayoutDesignsDefault,
        )
      }
      return resolveNewLayoutDesigns(
        oldInterfaceRetired(),
        store.general?.newLayoutDesigns,
        layoutTransitionEligible() ? legacyNewLayoutDesignsDefault : newLayoutDesignsDefault,
      )
    })
    const visible = (preference: () => boolean) => createMemo(() => !newLayoutDesigns() || preference())
    const initializeAgentVisibility = (existing: boolean) => {
      const initial = initialAgentVisibility(store.general?.agentVisibilityInitialized, existing, launchState.previous)
      if (initial === undefined) return
      batch(() => {
        setStore("general", "showCustomAgents", initial)
        setStore("general", "agentVisibilityInitialized", true)
      })
    }

    if (sunset && !oldInterfaceRetired()) {
      const timeout = { current: undefined as ReturnType<typeof setTimeout> | undefined }
      const checkSunset = () => {
        if (Date.now() >= sunset.getTime()) {
          setOldInterfaceRetired(true)
          return
        }
        timeout.current = setTimeout(checkSunset, nextSunsetCheckDelay(sunset.getTime(), Date.now()))
      }
      checkSunset()
      onCleanup(() => {
        if (timeout.current !== undefined) clearTimeout(timeout.current)
      })
    }

    createEffect(() => {
      if (!launchReady() || launchState.classified) return
      setLaunchState({
        classified: true,
        previous: launch.version,
      })
      if (!platform.version || launch.version === platform.version) return
      setLaunch("version", platform.version)
    })

    createEffect(() => {
      if (!ready() || !launchState.classified || platform.platform !== "web") return
      const existing = hasExistingWebState(settingsInit, launchState.previous)
      if (!layoutTransitionClassified()) setStore("general", "layoutTransitionEligible", existing)
      initializeAgentVisibility(existing)
    })

    createEffect(() => {
      if (!ready() || !launchState.classified || launchState.migrationApplied) return
      if (layoutUpgrade() && store.general?.newLayoutDesigns !== true) {
        setStore("general", "newLayoutDesigns", true)
      }
      setLaunchState("migrationApplied", true)
    })

    createEffect(() => {
      if (!ready() || !launchState.classified) return
      if (typeof store.general?.shouldDisplayTabsToast === "boolean") return
      if (!launchState.previous && !layoutTransitionClassified()) return
      setStore(
        "general",
        "shouldDisplayTabsToast",
        shouldDisplayTabsToast(launchState.previous, platform.version, layoutTransitionEligible()),
      )
    })

    createEffect(() => {
      if (!ready() || !oldInterfaceRetired()) return
      if (store.general?.newLayoutDesigns === true) return
      setStore("general", "newLayoutDesigns", true)
    })

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      const uiWeight = weight(store.appearance?.uiFontWeight, defaultSettings.appearance.uiFontWeight)
      const codeWeight = weight(store.appearance?.codeFontWeight, defaultSettings.appearance.codeFontWeight)
      const terminalWeight = weight(store.appearance?.terminalFontWeight, defaultSettings.appearance.terminalFontWeight)
      const sans = sansFontFamily(store.appearance?.sans, uiWeight)
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono, codeWeight))
      root.style.setProperty("--font-family-sans", sans)
      // The v2 layout renders message and UI text with --font-family-text, so
      // keep it in sync with the user-configurable UI font.
      root.style.setProperty("--font-family-text", sans)
      root.style.setProperty("--font-family-sans--font-weight", String(uiWeight))
      root.style.setProperty("--font-family-mono--font-weight", String(codeWeight))
      root.style.setProperty("--font-family-terminal--font-weight", String(terminalWeight))
      const messageWeight = weight(store.appearance?.messageFontWeight, defaultSettings.appearance.messageFontWeight)
      root.style.setProperty("--font-family-message", messageFontFamily(store.appearance?.message, messageWeight))
      root.style.setProperty("--font-family-message--font-weight", String(messageWeight))
      // The user-message bubble is capped with min(N%, var(...ch)); an empty
      // string restores the CSS fallback so the cap stays theme-controlled.
      const messageWidth = store.appearance?.messageWidth
      root.style.setProperty(
        "--message-width-ch",
        typeof messageWidth === "number" && messageWidth > 0 ? `${messageWidth}ch` : "",
      )
      // Alignment uses logical properties downstream, so left/right follow the
      // writing direction. Empty strings restore the CSS defaults (right).
      const messageAlign =
        store.appearance?.messageAlign === "left" || store.appearance?.messageAlign === "center"
          ? store.appearance?.messageAlign
          : ""
      root.style.setProperty("--message-align-start", messageAlign === "left" ? "0" : "")
      root.style.setProperty("--message-align-end", messageAlign ? "auto" : "")
      root.style.setProperty(
        "--message-align-items",
        messageAlign === "left" ? "flex-start" : messageAlign === "center" ? "center" : "",
      )
      // Thickness: only positive values override; 0/unset restore the CSS
      // fallbacks (none in base/new layout, the themed 1px border in old
      // layout) so existing users keep the current look.
      const messageBorderWidth = store.appearance?.messageBorderWidth
      root.style.setProperty(
        "--message-border-width",
        typeof messageBorderWidth === "number" && messageBorderWidth > 0 ? `${messageBorderWidth}px` : "",
      )
      root.style.setProperty(
        "--message-border-color",
        fontColor(store.appearance?.messageBorderColorLight, store.appearance?.messageBorderColorDark),
      )
      root.style.setProperty(
        "--message-background-color",
        fontColor(store.appearance?.messageBackgroundLight, store.appearance?.messageBackgroundDark),
      )
      // Text color of user message bubbles, independent of the shared Message
      // Font color; empty restores the inherited themed color.
      root.style.setProperty(
        "--message-text-color",
        fontColor(store.appearance?.userMessageTextColorLight, store.appearance?.userMessageTextColorDark),
      )
      // User-message bubble font, independent of the shared Message Font; an
      // empty font emits no override so the inherited --font-family-message
      // stack still applies.
      const userMessageFont = store.appearance?.userMessageFont?.trim()
      const userMessageWeight = weight(
        store.appearance?.userMessageFontWeight,
        defaultSettings.appearance.userMessageFontWeight,
      )
      root.style.setProperty(
        "--message-font-family",
        userMessageFont ? messageFontFamily(userMessageFont, userMessageWeight) : "",
      )
      root.style.setProperty("--message-font-family--font-weight", userMessageFont ? String(userMessageWeight) : "")
      // Font colors are resolved by the browser per color scheme via light-dark(),
      // falling back to the themed text color when the user leaves a value empty.
      root.style.setProperty(
        "--font-family-sans--color",
        fontColor(store.appearance?.uiFontColorLight, store.appearance?.uiFontColorDark),
      )
      root.style.setProperty(
        "--font-family-mono--color",
        fontColor(store.appearance?.codeFontColorLight, store.appearance?.codeFontColorDark),
      )
      root.style.setProperty(
        "--font-family-terminal--color",
        fontColor(store.appearance?.terminalFontColorLight, store.appearance?.terminalFontColorDark),
      )
      root.style.setProperty(
        "--font-family-message--color",
        fontColor(store.appearance?.messageFontColorLight, store.appearance?.messageFontColorDark),
      )
      // The UI font color overrides the primary text color of the app so the
      // user-chosen color shows up everywhere themed text is rendered. Setting
      // the property to an empty string restores the theme default.
      const uiFontColor = fontColor(store.appearance?.uiFontColorLight, store.appearance?.uiFontColorDark)
      if (uiFontColor) {
        root.style.setProperty("--v2-text-text-base", uiFontColor)
        root.style.setProperty("--text-strong", uiFontColor)
        root.style.setProperty("--text-base", uiFontColor)
      } else {
        root.style.removeProperty("--v2-text-text-base")
        root.style.removeProperty("--text-strong")
        root.style.removeProperty("--text-base")
      }
    })

    createEffect(() => {
      if (store.general?.followup !== "queue") return
      setStore("general", "followup", "steer")
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
        followup: withFallback(
          () => (store.general?.followup === "queue" ? "steer" : store.general?.followup),
          defaultSettings.general.followup,
        ),
        setFollowup(value: "queue" | "steer") {
          setStore("general", "followup", value === "queue" ? "steer" : value)
        },
        showFileTree,
        setShowFileTree(value: boolean) {
          setStore("general", "showFileTree", value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setStore("general", "showNavigation", value)
        },
        showSearch,
        setShowSearch(value: boolean) {
          setStore("general", "showSearch", value)
        },
        showStatus,
        setShowStatus(value: boolean) {
          setStore("general", "showStatus", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setStore("general", "showTerminal", value)
        },
        showReasoningSummaries: withFallback(
          () => store.general?.showReasoningSummaries,
          defaultSettings.general.showReasoningSummaries,
        ),
        setShowReasoningSummaries(value: boolean) {
          setStore("general", "showReasoningSummaries", value)
        },
        shellToolPartsExpanded: withFallback(
          () => store.general?.shellToolPartsExpanded,
          defaultSettings.general.shellToolPartsExpanded,
        ),
        setShellToolPartsExpanded(value: boolean) {
          setStore("general", "shellToolPartsExpanded", value)
        },
        editToolPartsExpanded: withFallback(
          () => store.general?.editToolPartsExpanded,
          defaultSettings.general.editToolPartsExpanded,
        ),
        setEditToolPartsExpanded(value: boolean) {
          setStore("general", "editToolPartsExpanded", value)
        },
        showCustomAgents,
        setShowCustomAgents(value: boolean) {
          setStore("general", "showCustomAgents", value)
        },
        mobileTitlebarPosition: withFallback(
          () => store.general?.mobileTitlebarPosition,
          defaultSettings.general.mobileTitlebarPosition,
        ),
        setMobileTitlebarPosition(value: "top" | "bottom") {
          setStore("general", "mobileTitlebarPosition", value)
        },
        newLayoutDesigns,
        setNewLayoutDesigns(value: boolean) {
          const next = oldInterfaceRetired() ? true : value
          if (newLayoutDesigns() === next) return
          setStore("general", "newLayoutDesigns", next)
          if (typeof window !== "undefined") setTimeout(() => window.location.reload())
        },
        layoutTransitionClassified,
        setOldLayoutEligible(eligible: boolean) {
          const current = store.general?.layoutTransitionEligible
          if (typeof current === "boolean") return
          setStore("general", "layoutTransitionEligible", eligible)
        },
        initializeAgentVisibility,
        layoutTransitionAvailable: createMemo(() => ready() && layoutTransition().available),
        newInterfaceNoticeVisible: createMemo(() => ready() && layoutTransition().notice),
        dismissNewInterfaceNotice() {
          setStore("general", "newInterfaceNoticeDismissed", true)
        },
        shouldDisplayTabsToast: withFallback(() => store.general?.shouldDisplayTabsToast, false),
        dismissTabsToast() {
          setStore("general", "shouldDisplayTabsToast", false)
        },
      },
      visibility: {
        fileTree: visible(showFileTree),
        search: visible(showSearch),
        status: visible(showStatus),
        customAgents: visible(showCustomAgents),
      },
      appearance: {
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setStore("appearance", "terminal", value.trim() ? value : "")
        },
        uiFontWeight: withFallback(() => store.appearance?.uiFontWeight, defaultSettings.appearance.uiFontWeight),
        setUIFontWeight(value: number) {
          setStore("appearance", "uiFontWeight", value)
        },
        codeFontWeight: withFallback(() => store.appearance?.codeFontWeight, defaultSettings.appearance.codeFontWeight),
        setCodeFontWeight(value: number) {
          setStore("appearance", "codeFontWeight", value)
        },
        terminalFontWeight: withFallback(
          () => store.appearance?.terminalFontWeight,
          defaultSettings.appearance.terminalFontWeight,
        ),
        setTerminalFontWeight(value: number) {
          setStore("appearance", "terminalFontWeight", value)
        },
        uiFontColorLight: withFallback(
          () => store.appearance?.uiFontColorLight,
          defaultSettings.appearance.uiFontColorLight,
        ),
        setUIFontColorLight(value: string) {
          setStore("appearance", "uiFontColorLight", color(value))
        },
        uiFontColorDark: withFallback(
          () => store.appearance?.uiFontColorDark,
          defaultSettings.appearance.uiFontColorDark,
        ),
        setUIFontColorDark(value: string) {
          setStore("appearance", "uiFontColorDark", color(value))
        },
        codeFontColorLight: withFallback(
          () => store.appearance?.codeFontColorLight,
          defaultSettings.appearance.codeFontColorLight,
        ),
        setCodeFontColorLight(value: string) {
          setStore("appearance", "codeFontColorLight", color(value))
        },
        codeFontColorDark: withFallback(
          () => store.appearance?.codeFontColorDark,
          defaultSettings.appearance.codeFontColorDark,
        ),
        setCodeFontColorDark(value: string) {
          setStore("appearance", "codeFontColorDark", color(value))
        },
        terminalFontColorLight: withFallback(
          () => store.appearance?.terminalFontColorLight,
          defaultSettings.appearance.terminalFontColorLight,
        ),
        setTerminalFontColorLight(value: string) {
          setStore("appearance", "terminalFontColorLight", color(value))
        },
        terminalFontColorDark: withFallback(
          () => store.appearance?.terminalFontColorDark,
          defaultSettings.appearance.terminalFontColorDark,
        ),
        setTerminalFontColorDark(value: string) {
          setStore("appearance", "terminalFontColorDark", color(value))
        },
        messageFont: withFallback(() => store.appearance?.message, defaultSettings.appearance.message),
        setMessageFont(value: string) {
          setStore("appearance", "message", value.trim() ? value : "")
        },
        messageWidth: withFallback(() => store.appearance?.messageWidth, defaultSettings.appearance.messageWidth),
        setMessageWidth(value: number) {
          setStore("appearance", "messageWidth", value)
        },
        messageAlign: withFallback(
          () => store.appearance?.messageAlign,
          defaultSettings.appearance.messageAlign,
        ),
        setMessageAlign(value: "left" | "center" | "right") {
          setStore("appearance", "messageAlign", value)
        },
        messageBorderWidth: withFallback(
          () => store.appearance?.messageBorderWidth,
          defaultSettings.appearance.messageBorderWidth,
        ),
        setMessageBorderWidth(value: number) {
          setStore("appearance", "messageBorderWidth", value)
        },
        messageBorderColorLight: withFallback(
          () => store.appearance?.messageBorderColorLight,
          defaultSettings.appearance.messageBorderColorLight,
        ),
        setMessageBorderColorLight(value: string) {
          setStore("appearance", "messageBorderColorLight", color(value))
        },
        messageBorderColorDark: withFallback(
          () => store.appearance?.messageBorderColorDark,
          defaultSettings.appearance.messageBorderColorDark,
        ),
        setMessageBorderColorDark(value: string) {
          setStore("appearance", "messageBorderColorDark", color(value))
        },
        messageBackgroundLight: withFallback(
          () => store.appearance?.messageBackgroundLight,
          defaultSettings.appearance.messageBackgroundLight,
        ),
        setMessageBackgroundLight(value: string) {
          setStore("appearance", "messageBackgroundLight", color(value))
        },
        messageBackgroundDark: withFallback(
          () => store.appearance?.messageBackgroundDark,
          defaultSettings.appearance.messageBackgroundDark,
        ),
        setMessageBackgroundDark(value: string) {
          setStore("appearance", "messageBackgroundDark", color(value))
        },
        messageFontWeight: withFallback(
          () => store.appearance?.messageFontWeight,
          defaultSettings.appearance.messageFontWeight,
        ),
        setMessageFontWeight(value: number) {
          setStore("appearance", "messageFontWeight", value)
        },
        messageFontColorLight: withFallback(
          () => store.appearance?.messageFontColorLight,
          defaultSettings.appearance.messageFontColorLight,
        ),
        setMessageFontColorLight(value: string) {
          setStore("appearance", "messageFontColorLight", color(value))
        },
        messageFontColorDark: withFallback(
          () => store.appearance?.messageFontColorDark,
          defaultSettings.appearance.messageFontColorDark,
        ),
        setMessageFontColorDark(value: string) {
          setStore("appearance", "messageFontColorDark", color(value))
        },
        userMessageTextColorLight: withFallback(
          () => store.appearance?.userMessageTextColorLight,
          defaultSettings.appearance.userMessageTextColorLight,
        ),
        setUserMessageTextColorLight(value: string) {
          setStore("appearance", "userMessageTextColorLight", color(value))
        },
        userMessageTextColorDark: withFallback(
          () => store.appearance?.userMessageTextColorDark,
          defaultSettings.appearance.userMessageTextColorDark,
        ),
        setUserMessageTextColorDark(value: string) {
          setStore("appearance", "userMessageTextColorDark", color(value))
        },
        userMessageFont: withFallback(() => store.appearance?.userMessageFont, defaultSettings.appearance.userMessageFont),
        setUserMessageFont(value: string) {
          setStore("appearance", "userMessageFont", value.trim() ? value : "")
        },
        userMessageFontWeight: withFallback(
          () => store.appearance?.userMessageFontWeight,
          defaultSettings.appearance.userMessageFontWeight,
        ),
        setUserMessageFontWeight(value: number) {
          setStore("appearance", "userMessageFontWeight", value)
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: withFallback(() => store.permissions?.autoApprove, defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      sounds: {
        agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
        setAgentEnabled(value: boolean) {
          setStore("sounds", "agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissionsEnabled: withFallback(
          () => store.sounds?.permissionsEnabled,
          defaultSettings.sounds.permissionsEnabled,
        ),
        setPermissionsEnabled(value: boolean) {
          setStore("sounds", "permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
    }
  },
})
