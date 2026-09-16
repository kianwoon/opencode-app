# secret-broker: dangling secret:// scheme dead-ended agents

**Gotcha:** The broker blocked env-file reads but its denial message never said secrets
are injected into shell child-process env as $KEY_NAME. Meanwhile env values like
secret://project/APP_ENV (unimplemented scheme, no resolver) were injected as literal
useless strings. Agents rationally concluded "no key access" and abandoned the task.

**Fix shipped (packages/secret-broker):**
- denialMessage now lists injected key names (names only) + $VAR child-process usage pattern
- env-loader drops secret:// values with a console.warn (never injected, never redacted)
- README "Agent usage contract" section; notes MCP tools get no injection — native shell only

**Acceptance gate:** bun secret://project/APP_ENV in packages/secret-broker green (87 pass / 0 fail), typecheck + build clean.

**Pattern:** Security tools must advertise the sanctioned path in their denial messages,
or agents treat enforcement as a dead end.
