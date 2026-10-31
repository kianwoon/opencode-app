;(function () {
  // Must stay in sync with THEME_CSS_CACHE_VERSION and V2_CSS_MARKER in
  // packages/ui/src/theme/context.tsx: cached CSS from another token generation
  // is never injected, so a stale cache cannot paint mismatched tokens.
  var CACHE_VERSION = "2"
  var V2_MARKER = "--v2-text-text-base:"

  var key = "opencode-theme-id"
  var themeId = localStorage.getItem(key) || "oc-2"

  var scheme = localStorage.getItem("opencode-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = isDark ? "#080808" : "#fafafa"

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", isDark ? "#080808" : "#fafafa")

  if (themeId === "oc-2") return

  var cachedVersion = localStorage.getItem("opencode-theme-css-version")
  var css = localStorage.getItem("opencode-theme-css-" + mode)
  var valid = cachedVersion === CACHE_VERSION && !!css && css.indexOf(V2_MARKER) !== -1

  if (!valid) {
    // A cache from another token generation is invalid: leave the app's
    // ThemeProvider to apply (and re-cache) fresh CSS on boot.
    var stale = document.getElementById("oc-theme-preload")
    if (stale) stale.remove()

    return
  }

  var style = document.createElement("style")
  style.id = "oc-theme-preload"
  style.textContent =
    ":root{color-scheme:" +
    mode +
    ";--text-mix-blend-mode:" +
    (isDark ? "plus-lighter" : "multiply") +
    ";" +
    css +
    "}"
  document.head.appendChild(style)
})()
