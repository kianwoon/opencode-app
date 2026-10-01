# 2026-10-02 — Silent no-op #3: registry Tool.init is NOT tool exposure

Constructing a tool (Tool.init + registry map entry) and granting it in an agent
permission block does NOT make it model-reachable. The ONLY supply path to
sessions is the `builtin` array in ToolRegistry (packages/opencode/src/tool/registry.ts
~:252-274, returned as `[...s.builtin, ...s.custom]` at ~:283); resolveTools
(session/llm/request.ts:221) only FILTERS, never adds.

Incident: jev_accept / jev_label / jev_rank (built 2026-09-25: fa482ef9c3,
e56134f026, 31ffa84644) were initialized in the registry map and granted allow
in config/brain.ts:31-33, but never added to `builtin`. Every brain session's
permission manifest listed them as allow while no session ever received the
tools; whole-DB exact-equality count shows zero calls ever, including exposed
jev_decide. Settings catalogs (permissions.tsx / subagent.tsx OWNS_GROUPS) could
not show them either.

Dating rule: `git log -S "<toolname>" -- <registry file>`: ONE commit =
born-unexposed (unfinished wiring, never hidden); TWO+ commits = added then
removed (deliberate). Pair with a whole-DB exact json_extract call count
(never LIKE — self-contamination).

Acceptance gate: the tool appears in a fresh session's advertised tools AND in
the Settings catalog (OWNS_GROUPS + i18n keys), so the manifest grant and the
advertised set agree; or delete the tool and its grants entirely. Never leave
init-without-exposure.