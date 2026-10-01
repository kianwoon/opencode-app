# Auditing agent config effectiveness: compare against the LIVE resolved agents, not the files

- **Date**: 2026-10-02T00:57:16+0800
- **Type**: lesson

## What happened

To answer 'is my subagent config effective?' you must compare THREE layers: (1) the configured blocks in opencode.json, (2) the .md frontmatter keys (the shadowing set), (3) the LIVE resolved agents. Files alone mislead in both directions. The live source is the desktop sidecar: find the port with lsof -nP -iTCP -sTCP:LISTEN | grep -i electron | grep 127.0.0.1, then GET /agent (v1) authed with OPENCODE_SERVER_USERNAME/PASSWORD. /app/agents returns HTTP 200 but is the SPA fallback, not JSON.

## Root cause / fix

Findings pattern from a real audit: tools/skills/capabilities/permissions/models were all injected EXACTLY (config->resolved, zero drift) - the wire field is tools, not owned_tools; extra resolved permission keys (*, doom_loop, plan_enter, plan_exit, question) are runtime-injected defaults, NOT lost config. The only genuine defect class is the .md frontmatter shadowing a key the UI writes (description, mode - model too before it was removed from the .md). TRAP: a config block WITH disable:true is an intentional tombstone, not dead config - the runtime filters it out (16 config blocks to 14 live agents); do NOT flag its permission keys as unreachable. Acceptance gate: report each non-primary agent as NAME | model cfg->resolved | mdKeys | tools/skills/caps cfg->resolved | permission cfg-keys->resolved-keys, and label a disable:true absence INTENTIONAL, never broken.
