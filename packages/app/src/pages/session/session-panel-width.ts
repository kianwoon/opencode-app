// The review pane has no width of its own: it takes whatever the chat panel
// leaves behind. Instead of capping the chat panel at a fraction of the window
// (which forces the review pane to grow with the monitor), reserve a fixed
// minimum for the review pane and let the chat panel take everything else.
export const SESSION_PANEL_WIDTH_MIN = 450
export const REVIEW_PANE_WIDTH_MIN = 100

export function sessionPanelWidthMax(input: { available: number }) {
  return Math.max(SESSION_PANEL_WIDTH_MIN, input.available - REVIEW_PANE_WIDTH_MIN)
}

// `available` is undefined until the layout row is first measured; render the
// stored width untouched until then to avoid a first-frame snap.
export function clampSessionPanelWidth(input: { width: number; available: number | undefined }) {
  if (input.available === undefined) return input.width
  return Math.min(input.width, sessionPanelWidthMax({ available: input.available }))
}
