import { describe, expect, test } from "bun:test"
import {
  navigateTaskSessionOnLeftClick,
  resolveTaskSession,
  type TaskSession,
} from "./message-part-task"

describe("task session navigation", () => {
  test("resolves a stored child for an error task with missing metadata and navigates on left click", () => {
    const sessions: TaskSession[] = [
      {
        id: "ses_wrong_agent",
        parentID: "ses_parent",
        title: "Implement regression @Build",
        time: { created: 30 },
      },
      {
        id: "ses_wrong_parent",
        parentID: "ses_other",
        title: "Implement regression @Implementer",
        time: { created: 40 },
      },
      {
        id: "ses_child",
        parentID: "ses_parent",
        title: "Implement regression @Implementer",
        time: { created: 20 },
      },
    ]
    const sessionID = resolveTaskSession({
      metadata: {},
      description: "Implement regression",
      agent: "Implementer",
      parentID: "ses_parent",
      sessions,
    })
    const event = new Event("click", { cancelable: true })
    Object.defineProperties(event, {
      button: { value: 0 },
      altKey: { value: false },
      ctrlKey: { value: false },
      metaKey: { value: false },
      shiftKey: { value: false },
    })
    const navigated: string[] = []

    navigateTaskSessionOnLeftClick(event as MouseEvent, () => {
      if (!sessionID) return
      navigated.push(sessionID)
    })

    expect(sessionID).toBe("ses_child")
    expect(navigated).toEqual(["ses_child"])
    expect(event.defaultPrevented).toBe(true)
  })
})
