import { produce, reconcile, unwrap } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Effect, Option, Predicate, Schema, SchemaGetter } from "effect"
import { createSimpleContext } from "@opencode/ui/context"
import { setNewIcons } from "@opencode/ui/icon"
import { timelinePresets, type TimelineCategory, type TimelineDetail } from "@opencode/session-ui/timeline/detail"
import { persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { ScopedKey, type ServerScope } from "@/runtime/server/scope"

export type Settings = typeof settingsSchema.Type

export type WorkspaceDefaultDestination = Settings["workspaces"]["defaultDestination"]

export type WorkspaceLastUsed = Settings["workspaces"]["lastUsed"][string]

export type FollowUpBehavior = Settings["general"]["followUpBehavior"]

export type BackgroundActivity = Settings["general"]["backgroundActivity"]

export type TimelineWidth = Settings["general"]["timelineWidth"]

export type TabLayout = Settings["appearance"]["tabLayout"]

export type MessageAlign = Settings["appearance"]["messageAlign"]

export type ReduceMotion = Settings["appearance"]["reduceMotion"]

export type NotificationSettings = Settings["notifications"]

export type SoundSettings = Settings["sounds"]

// Names a project for per-project settings: project IDs are only unique within one server.
export function projectSettingsKey(scope: ServerScope, projectID: string | undefined) {
  return projectID ? ScopedKey.from(scope, projectID) : undefined
}

export const monoDefault = "IBM Plex Mono"

export const sansDefault = "Inter"

export const terminalDefault = "JetBrainsMono Nerd Font Mono"

const monoFallback =
  '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const sansFallback = '"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

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

// macOS installs many per-weight faces as separate families: "IBM Plex Mono
// Light" is its own family, so `font-weight: 300` on "IBM Plex Mono" does not
// select it. Prepend weight-qualified family names so the weight control works
// for those fonts; variable fonts still honour the requested `font-weight`.
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

export function weight(value: number | undefined, fallback: number) {
  return value ?? fallback
}

export function color(value: string | undefined) {
  const trimmed = value?.trim()

  return trimmed ? trimmed : ""
}

// Resolves a light/dark pair into a CSS color. Empty pairs emit nothing so the
// consumer keeps its themed fallback; a single value applies to both schemes.
export function fontColor(light: string | undefined, dark: string | undefined) {
  const lightValue = color(light)
  const darkValue = color(dark)

  if (!lightValue && !darkValue) return ""

  if (lightValue && darkValue) return `light-dark(${lightValue}, ${darkValue})`

  return lightValue || darkValue
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

const placementSchema = Schema.Literals(["separate", "grouped", "hidden"])

const detailsSchema = Schema.Literals(["collapsed", "expanded"])

const activitySchema = Persistence.struct({ placement: placementSchema, details: detailsSchema })

const placementOnlySchema = Persistence.struct({ placement: placementSchema })

const generalSchema = Persistence.struct({
  // Retired preferences without readers; kept so stored values still decode and round-trip.
  autoSave: Persistence.optional(Schema.Boolean),
  showFileTree: Persistence.optional(Schema.Boolean),
  showTurnNavigator: Persistence.optional(Schema.Boolean),
  // Owned by the updater plugin, which copies it out once; kept so settings rewrites cannot drop it first.
  releaseNotes: Persistence.optional(Schema.Boolean),
  showNavigation: Persistence.optional(Schema.Boolean),
  showSearch: Persistence.optional(Schema.Boolean),
  showTerminal: Persistence.optional(Schema.Boolean),
  timelineDetail: Persistence.struct({
    shell: activitySchema,
    edit: activitySchema,
    thinking: activitySchema,
    subagents: placementOnlySchema,
    notices: placementOnlySchema,
    tools: placementOnlySchema,
    commentary: placementOnlySchema,
  }),
  showCustomAgents: Schema.Boolean,
  showTurnDiffs: Schema.Boolean,
  backgroundActivity: Schema.Literals(["off", "left", "center", "right"]),
  timelineWidth: Schema.Literals(["focused", "comfortable", "wide"]),
  // The "New icons" design experiment, off until it ships.
  newIcons: Schema.Boolean,
  // The "Fold long messages" experiment, off until it ships.
  foldUserMessages: Schema.Boolean,
  // The redesigned keyboard-first question dock, off until it ships.
  newQuestionUI: Schema.Boolean,
  mobileTitlebarPosition: Schema.Literals(["top", "bottom"]),
  // Owned by the review plugin, which copies it out once; kept so settings rewrites cannot drop it first.
  mobileDiffWrap: Persistence.optional(Schema.Boolean),
  followUpBehavior: Schema.Literals(["queue", "steer"]),
})

const appearanceSchema = Persistence.struct({
  fontSize: Schema.Number,
  mono: Schema.String,
  sans: Schema.String,
  terminal: Schema.String,
  uiFontWeight: Schema.Number,
  codeFontWeight: Schema.Number,
  message: Schema.String,
  messageFontWeight: Schema.Number,
  userMessageFont: Schema.String,
  userMessageFontWeight: Schema.Number,
  messageWidth: Schema.Number,
  messageAlign: Schema.Literals(["left", "center", "right"]),
  messageBorderWidth: Schema.Number,
  messageBorderColorLight: Schema.String,
  messageBorderColorDark: Schema.String,
  messageBackgroundLight: Schema.String,
  messageBackgroundDark: Schema.String,
  // "inbox" is experimental: the vertical layout with a server-wide session inbox in place of tabs.
  tabLayout: Schema.Literals(["horizontal", "vertical", "inbox"]),
  sidebarOpen: Persistence.optional(Schema.Boolean),
  reduceMotion: Schema.Literals(["system", "on", "off"]),
})

const permissionsSchema = Persistence.struct({
  // The default for every project.
  autoApprove: Schema.Boolean,
  // Projects that override the default, keyed by server scope and project ID. Absent projects use the default.
  autoApproveProjects: Persistence.record(
    Schema.Boolean.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
  ),
})

const workspacesSchema = Persistence.struct({
  defaultDestination: Schema.Literals(["last-used", "local", "new"]),
  lastUsed: Persistence.record(
    Schema.Literals(["local", "workspace"]).pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
  ),
})

const notificationsSchema = Persistence.struct({
  agent: Schema.Boolean,
  permissions: Schema.Boolean,
  questions: Schema.Boolean,
  errors: Schema.Boolean,
})

const soundsSchema = Persistence.struct({
  agentEnabled: Schema.Boolean,
  agent: Schema.String,
  permissionsEnabled: Schema.Boolean,
  permissions: Schema.String,
  questionsEnabled: Schema.Boolean,
  questions: Schema.String,
  errorsEnabled: Schema.Boolean,
  errors: Schema.String,
  interfaceEnabled: Schema.optional(Schema.Boolean),
})

export const settingsSchema = Persistence.struct({
  general: generalSchema,
  // Owned by the details plugin, which copies it out once; kept so settings rewrites cannot drop it first.
  sessionSummary: Schema.optional(
    Persistence.struct({ projectExpanded: Schema.Boolean, serverExpanded: Schema.Boolean }),
  ),
  appearance: appearanceSchema,
  keybinds: Persistence.record(Schema.String.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none())))),
  permissions: permissionsSchema,
  workspaces: workspacesSchema,
  notifications: notificationsSchema,
  sounds: soundsSchema,
})

function storedTimelineCategory(category: TimelineCategory) {
  return Persistence.optional(
    Schema.Union([
      Persistence.legacy({
        placement: Persistence.optional(placementSchema),
        details: Persistence.optional(detailsSchema),
      }),
      Schema.Literals(["expanded", "collapsed", "hidden", "visible"]),
    ]).pipe(
      Schema.decode({
        decode: SchemaGetter.transform((value) => {
          if (!Predicate.isString(value)) return value

          return {
            placement:
              value === "hidden"
                ? "hidden"
                : category === "subagents"
                  ? "separate"
                  : category === "tools"
                    ? "grouped"
                    : value === "expanded"
                      ? "separate"
                      : value === "collapsed"
                        ? "grouped"
                        : undefined,
            details: value === "expanded" ? "expanded" : "collapsed",
          }
        }),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  )
}

function legacyTimelineActivity(value: boolean | "hidden" | "compact" | "full" | null | undefined) {
  if (value === undefined || value === null) return
  const expanded = value === true || value === "full"

  return {
    placement: value === "hidden" ? "hidden" : expanded ? "separate" : "grouped",
    details: expanded ? "expanded" : "collapsed",
  } as const
}

export const settingsPersistence = Persistence.migrate(
  settingsSchema,
  Persistence.legacy({
    general: Persistence.optional(
      Persistence.legacy({
        // Keep invalid explicit values distinct from absent values so legacy preferences cannot replace them.
        timelineDetail: Schema.optional(
          Schema.NullOr(
            Persistence.legacy({
              shell: storedTimelineCategory("shell"),
              edit: storedTimelineCategory("edit"),
              thinking: storedTimelineCategory("thinking"),
              subagents: storedTimelineCategory("subagents"),
              notices: storedTimelineCategory("notices"),
              tools: storedTimelineCategory("tools"),
            }),
          ),
        ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null)))),
        reasoningMode: Schema.optional(Schema.NullOr(Schema.Literals(["hidden", "compact", "full"]))).pipe(
          Schema.catchDecoding(() => Effect.succeed(Option.some(null))),
        ),
        showReasoningSummaries: Persistence.optional(Schema.Boolean),
        shellToolPartsExpanded: Persistence.optional(Schema.Boolean),
        editToolPartsExpanded: Persistence.optional(Schema.Boolean),
      }),
    ),
  }).pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => {
        const general = value.general

        if (!general || general.timelineDetail !== undefined) return value

        return {
          ...value,
          general: {
            ...general,
            timelineDetail: {
              shell: legacyTimelineActivity(general.shellToolPartsExpanded),
              edit: legacyTimelineActivity(general.editToolPartsExpanded),
              thinking: legacyTimelineActivity(
                general.reasoningMode === undefined ? general.showReasoningSummaries : general.reasoningMode,
              ),
            },
          },
        }
      }),
      encode: SchemaGetter.transform((value) => value),
    }),
  ),
)

export const defaultSettings: Settings = {
  general: {
    timelineDetail: { ...timelinePresets[2].value },
    showCustomAgents: false,
    showTurnDiffs: false,
    backgroundActivity: "left",
    timelineWidth: "comfortable",
    newIcons: false,
    foldUserMessages: false,
    newQuestionUI: false,
    mobileTitlebarPosition: "top",
    followUpBehavior: "steer",
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
    uiFontWeight: 400,
    codeFontWeight: 400,
    message: "",
    messageFontWeight: 400,
    userMessageFont: "",
    userMessageFontWeight: 400,
    // 0 means "no explicit character cap": the percentage cap binds on its own.
    messageWidth: 0,
    messageAlign: "right",
    messageBorderWidth: 0,
    messageBorderColorLight: "",
    messageBorderColorDark: "",
    messageBackgroundLight: "",
    messageBackgroundDark: "",
    tabLayout: "horizontal",
    reduceMotion: "system",
  },
  keybinds: {},
  permissions: { autoApprove: false, autoApproveProjects: {} },
  workspaces: { defaultDestination: "last-used", lastUsed: {} },
  notifications: { agent: false, permissions: true, questions: true, errors: false },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    questionsEnabled: true,
    questions: "staplebops-05",
    errorsEnabled: true,
    errors: "nope-03",
    interfaceEnabled: true,
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  gate: false,
  init: () => {
    const [store, setStore, , ready] = persisted({ key: "settings.v3" }, settingsPersistence, defaultSettings)

    const showCustomAgents = withFallback(
      () => store.general?.showCustomAgents,
      defaultSettings.general.showCustomAgents,
    )

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      const appearance = store.appearance
      const uiWeight = weight(appearance?.uiFontWeight, defaultSettings.appearance.uiFontWeight)
      const codeWeight = weight(appearance?.codeFontWeight, defaultSettings.appearance.codeFontWeight)
      const messageWeight = weight(appearance?.messageFontWeight, defaultSettings.appearance.messageFontWeight)
      const userMessageWeight = weight(
        appearance?.userMessageFontWeight,
        defaultSettings.appearance.userMessageFontWeight,
      )
      const mono = monoFontFamily(appearance?.mono, codeWeight)
      root.style.setProperty("--font-family-mono", mono)
      root.style.setProperty("--font-family-sans", sansFontFamily(appearance?.sans, uiWeight))
      root.style.setProperty("--font-family-sans--font-weight", String(uiWeight))
      root.style.setProperty("--font-family-mono--font-weight", String(codeWeight))
      // Message text and the composer read the message role, which falls back to
      // the sans stack so an empty message font still follows the UI font.
      root.style.setProperty("--font-family-message", messageFontFamily(appearance?.message, messageWeight))
      root.style.setProperty("--font-family-message--font-weight", String(messageWeight))
      // The user bubble's own font only overrides the family when the user sets
      // one; its weight always applies so the control is not inert without a font.
      const userMessageFont = appearance?.userMessageFont?.trim()
      root.style.setProperty(
        "--message-font-family",
        userMessageFont ? messageFontFamily(userMessageFont, userMessageWeight) : "",
      )
      root.style.setProperty("--message-font-family--font-weight", String(userMessageWeight))
      // The bubble is capped with min(N%, var(...ch)). The percentage cap is the
      // default binding cap; the character cap only binds when the user explicitly
      // picks a narrower width. With no stored width, --message-width-ch is empty
      // so the CSS fallback (100%) restores and the percentage wins on its own.
      // A persisted 64 from an older profile stays a real 64ch choice.
      const messageWidth = appearance?.messageWidth
      root.style.setProperty(
        "--message-width-ch",
        typeof messageWidth === "number" && messageWidth > 0 ? `${messageWidth}ch` : "",
      )
      root.style.setProperty(
        "--message-width-pct",
        typeof messageWidth === "number" && messageWidth >= 160 ? "90%" : "95%",
      )
      // Alignment uses logical properties downstream, so left/right follow the
      // writing direction. Empty strings restore the CSS defaults (right).
      const messageAlign =
        appearance?.messageAlign === "left" || appearance?.messageAlign === "center" ? appearance.messageAlign : ""
      root.style.setProperty("--message-align-start", messageAlign === "left" ? "0" : "")
      root.style.setProperty("--message-align-end", messageAlign ? "auto" : "")
      root.style.setProperty(
        "--message-align-items",
        messageAlign === "left" ? "flex-start" : messageAlign === "center" ? "center" : "",
      )
      // Only a positive thickness overrides; 0 restores the borderless fallback.
      const messageBorderWidth = appearance?.messageBorderWidth
      root.style.setProperty(
        "--message-border-width",
        typeof messageBorderWidth === "number" && messageBorderWidth > 0 ? `${messageBorderWidth}px` : "",
      )
      root.style.setProperty(
        "--message-border-color",
        fontColor(appearance?.messageBorderColorLight, appearance?.messageBorderColorDark),
      )
      root.style.setProperty(
        "--message-background-color",
        fontColor(appearance?.messageBackgroundLight, appearance?.messageBackgroundDark),
      )
      // Inline code can first appear during history backfill. Load its selected
      // face with the shell so that font discovery does not resize that mount.
      void document.fonts?.load(`440 13px ${mono}`).catch(() => undefined)
    })

    const newIcons = withFallback(() => store.general?.newIcons, defaultSettings.general.newIcons)
    createEffect(() => setNewIcons(newIcons()))

    const reduceMotion = withFallback(() => store.appearance?.reduceMotion, defaultSettings.appearance.reduceMotion)
    const systemReducedMotion = createMediaQuery("(prefers-reduced-motion: reduce)")

    // Motion styles key off this attribute instead of the media query so the setting can override the system.
    createEffect(() => {
      if (typeof document === "undefined") return
      const reduce = reduceMotion() === "system" ? systemReducedMotion() : reduceMotion() === "on"
      document.documentElement.dataset.motion = reduce ? "reduce" : "full"
    })

    const timelineWidth = withFallback(() => store.general?.timelineWidth, defaultSettings.general.timelineWidth)

    // The session column's width token keys off this attribute, so every surface sharing it follows the setting.
    createEffect(() => {
      if (typeof document === "undefined") return
      document.documentElement.dataset.timelineWidth = timelineWidth()
    })

    const autoApproveDefault = withFallback(
      () => store.permissions?.autoApprove,
      defaultSettings.permissions.autoApprove,
    )

    // A project's explicit choice, or undefined when it uses the default.
    const autoApproveOverride = (project: ScopedKey | undefined) =>
      project ? store.permissions?.autoApproveProjects?.[project] : undefined

    return {
      ready,
      get current() {
        return store
      },
      general: {
        timelineDetail: withFallback(() => store.general?.timelineDetail, defaultSettings.general.timelineDetail),
        setTimelineDetail(value: TimelineDetail) {
          setStore("general", "timelineDetail", structuredClone(unwrap(value)))
        },
        showCustomAgents,
        setShowCustomAgents(value: boolean) {
          setStore("general", "showCustomAgents", value)
        },
        showTurnDiffs: withFallback(() => store.general?.showTurnDiffs, defaultSettings.general.showTurnDiffs),
        setShowTurnDiffs(value: boolean) {
          setStore("general", "showTurnDiffs", value)
        },
        backgroundActivity: withFallback(
          () => store.general?.backgroundActivity,
          defaultSettings.general.backgroundActivity,
        ),
        setBackgroundActivity(value: BackgroundActivity) {
          setStore("general", "backgroundActivity", value)
        },
        timelineWidth,
        setTimelineWidth(value: TimelineWidth) {
          setStore("general", "timelineWidth", value)
        },
        newIcons,
        setNewIcons(value: boolean) {
          setStore("general", "newIcons", value)
        },
        foldUserMessages: withFallback(() => store.general?.foldUserMessages, defaultSettings.general.foldUserMessages),
        setFoldUserMessages(value: boolean) {
          setStore("general", "foldUserMessages", value)
        },
        newQuestionUI: withFallback(() => store.general?.newQuestionUI, defaultSettings.general.newQuestionUI),
        setNewQuestionUI(value: boolean) {
          setStore("general", "newQuestionUI", value)
        },
        mobileTitlebarPosition: withFallback(
          () => store.general?.mobileTitlebarPosition,
          defaultSettings.general.mobileTitlebarPosition,
        ),
        setMobileTitlebarPosition(value: "top" | "bottom") {
          setStore("general", "mobileTitlebarPosition", value)
        },
        followUpBehavior: withFallback(() => store.general?.followUpBehavior, defaultSettings.general.followUpBehavior),
        setFollowUpBehavior(value: FollowUpBehavior) {
          setStore("general", "followUpBehavior", value)
        },
      },
      visibility: {
        customAgents: showCustomAgents,
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
        uiFontWeight: withFallback(
          () => store.appearance?.uiFontWeight,
          defaultSettings.appearance.uiFontWeight,
        ),
        setUIFontWeight(value: number) {
          setStore("appearance", "uiFontWeight", value)
        },
        codeFontWeight: withFallback(
          () => store.appearance?.codeFontWeight,
          defaultSettings.appearance.codeFontWeight,
        ),
        setCodeFontWeight(value: number) {
          setStore("appearance", "codeFontWeight", value)
        },
        messageFont: withFallback(() => store.appearance?.message, defaultSettings.appearance.message),
        setMessageFont(value: string) {
          setStore("appearance", "message", value.trim() ? value : "")
        },
        messageFontWeight: withFallback(
          () => store.appearance?.messageFontWeight,
          defaultSettings.appearance.messageFontWeight,
        ),
        setMessageFontWeight(value: number) {
          setStore("appearance", "messageFontWeight", value)
        },
        userMessageFont: withFallback(
          () => store.appearance?.userMessageFont,
          defaultSettings.appearance.userMessageFont,
        ),
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
        messageWidth: withFallback(() => store.appearance?.messageWidth, defaultSettings.appearance.messageWidth),
        setMessageWidth(value: number) {
          setStore("appearance", "messageWidth", value)
        },
        messageAlign: withFallback(() => store.appearance?.messageAlign, defaultSettings.appearance.messageAlign),
        setMessageAlign(value: MessageAlign) {
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
          setStore("appearance", "messageBorderColorLight", value)
        },
        messageBorderColorDark: withFallback(
          () => store.appearance?.messageBorderColorDark,
          defaultSettings.appearance.messageBorderColorDark,
        ),
        setMessageBorderColorDark(value: string) {
          setStore("appearance", "messageBorderColorDark", value)
        },
        messageBackgroundLight: withFallback(
          () => store.appearance?.messageBackgroundLight,
          defaultSettings.appearance.messageBackgroundLight,
        ),
        setMessageBackgroundLight(value: string) {
          setStore("appearance", "messageBackgroundLight", value)
        },
        messageBackgroundDark: withFallback(
          () => store.appearance?.messageBackgroundDark,
          defaultSettings.appearance.messageBackgroundDark,
        ),
        setMessageBackgroundDark(value: string) {
          setStore("appearance", "messageBackgroundDark", value)
        },
        tabLayout: withFallback(() => store.appearance?.tabLayout, defaultSettings.appearance.tabLayout),
        setTabLayout(value: TabLayout) {
          setStore("appearance", "tabLayout", value)
        },
        sidebarOpen: withFallback(() => store.appearance?.sidebarOpen, true),
        setSidebarOpen(value: boolean) {
          setStore("appearance", "sidebarOpen", value)
        },
        reduceMotion,
        setReduceMotion(value: ReduceMotion) {
          setStore("appearance", "reduceMotion", value)
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          // A returned object would merge into the stored one, keeping the key; delete it on the store itself.
          setStore(
            "keybinds",
            produce((draft) => {
              delete draft[action]
            }),
          )
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApproveDefault,
        setAutoApproveDefault(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
        autoApproveOverride,
        // Undefined makes the project use the default again.
        setAutoApproveOverride(project: ScopedKey, value: boolean | undefined) {
          const projects = { ...store.permissions?.autoApproveProjects }

          if (value === undefined) delete projects[project]
          else projects[project] = value
          setStore("permissions", "autoApproveProjects", reconcile(projects))
        },
        // Whether a project's requests are approved without asking.
        autoApproves: (project: ScopedKey | undefined) => autoApproveOverride(project) ?? autoApproveDefault(),
        // Whether any request on the server may be approved without asking.
        autoApprovesOnServer(scope: ServerScope) {
          if (autoApproveDefault()) return true
          const prefix = ScopedKey.prefix(scope)

          return Object.entries(store.permissions?.autoApproveProjects ?? {}).some(
            ([key, value]) => value && key.startsWith(prefix),
          )
        },
      },
      workspaces: {
        defaultDestination: withFallback(
          () => store.workspaces?.defaultDestination,
          defaultSettings.workspaces.defaultDestination,
        ),
        setDefaultDestination(value: WorkspaceDefaultDestination) {
          setStore("workspaces", (current) => ({
            ...defaultSettings.workspaces,
            ...current,
            defaultDestination: value,
          }))
        },
        lastUsed(scope: ServerScope, projectID: string) {
          return store.workspaces?.lastUsed?.[ScopedKey.from(scope, projectID)]
        },
        setLastUsed(scope: ServerScope, projectID: string, value: WorkspaceLastUsed) {
          setStore("workspaces", (current) => ({
            ...defaultSettings.workspaces,
            ...current,
            lastUsed: { ...current?.lastUsed, [ScopedKey.from(scope, projectID)]: value },
          }))
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
        questions: withFallback(() => store.notifications?.questions, defaultSettings.notifications.questions),
        setQuestions(value: boolean) {
          setStore("notifications", "questions", value)
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
        questionsEnabled: withFallback(() => store.sounds?.questionsEnabled, defaultSettings.sounds.questionsEnabled),
        setQuestionsEnabled(value: boolean) {
          setStore("sounds", "questionsEnabled", value)
        },
        questions: withFallback(() => store.sounds?.questions, defaultSettings.sounds.questions),
        setQuestions(value: string) {
          setStore("sounds", "questions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
        interfaceEnabled: withFallback(
          () => store.sounds?.interfaceEnabled,
          defaultSettings.sounds.interfaceEnabled ?? true,
        ),
        setInterfaceEnabled(value: boolean) {
          setStore("sounds", "interfaceEnabled", value)
        },
      },
    }
  },
})
