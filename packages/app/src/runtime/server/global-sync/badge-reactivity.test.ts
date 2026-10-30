import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import { busyChildrenByParent } from "../../pages/layout/helpers"
import type { State } from "./types"
import { applyDirectoryEvent } from "./event-reducer"

// Reactivity is NOT measurable under bun test (solid-js resolves to the non-reactive server build — see .opencode/MEMORY/2026-09-26-bun-test-solid-js-server-build-no-reactivity.md). These tests cover the reducer -> store -> helper DATA path; the reactive behavior is verified in the desktop runtime.

const rootSession = (input: { id: string; parentID?: string; archived?: number }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    // roots() filters on pathKey(session.directory), which indexes into the
    // value — a session without one throws rather than filtering out.
    directory: "/tmp",
    time: {
      created: 1,
      updated: 1,
      archived: input.archived,
    },
  }) as Session

// Mirrors the store shape the event-reducer harness builds. The badge helper
// only reads session + session_status, but the reducer writes sessionTotal and
// session_status_at too, so the full shape is kept.
const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    sessionVersion: 0,
    session_status: {},
    session_status_at: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as State

// The badge helper reads the server-scoped session data shape (info keyed by id
// + session_status); the reducer harness produces the per-directory store, so
// reshape it here rather than coupling the helper to the child store.
const workData = (store: State) => ({
  info: Object.fromEntries(store.session.map((session) => [session.id, session])),
  session_status: store.session_status,
})

describe("badge reactivity", () => {
  test("empty start: reducer writes land and the helper counts the busy child", () => {
    const [store, setStore] = createStore(baseState())

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "ses_root" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: {
        type: "session.created",
        properties: { info: rootSession({ id: "ses_kid", parentID: "ses_root" }) },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "session.status", properties: { sessionID: "ses_kid", status: { type: "busy" } } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session_status.ses_kid).toEqual({ type: "busy" })
    expect(busyChildrenByParent(workData(store)).get("ses_root")).toBe(1)
  })

  test("populated start: a status write is read by the helper", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [
          rootSession({ id: "ses_root" }),
          rootSession({ id: "ses_kid", parentID: "ses_root" }),
        ],
        sessionTotal: 1,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.status", properties: { sessionID: "ses_kid", status: { type: "busy" } } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session_status.ses_kid).toEqual({ type: "busy" })
    expect(busyChildrenByParent(workData(store)).get("ses_root")).toBe(1)
  })
})
