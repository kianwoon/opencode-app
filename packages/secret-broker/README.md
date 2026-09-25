# opencode-secret-broker

Standalone OpenCode plugin: injects allowlisted `.env` secrets into child
process environments and redacts them from every model-visible channel.

## Install

```json
{
  "plugin": ["opencode-secret-broker"]
}
```

OpenCode loads the `./server` export of the package.

## Built-in broker / double-run

The host ships a built-in broker **enabled by default**. Wiring this package into
`plugin[]` is detected by specifier — the published name `opencode-secret-broker`,
or a path containing a `secret-broker` or `opencode-secret-broker` segment — and
the built-in then yields, so exactly one broker ever runs. The host logs a
one-line `console.warn` when it yields.

`OPENCODE_DISABLE_SECRET_BROKER=1` turns the built-in off when this package is NOT
wired. Do not set it alongside this package: the flag also gates off the
Execution Guard, the layer that strips injected keys from install, build, and
test commands.

## Configuration

- `.env` — real secret values (never read by the model; denied to tools).
- `.env.example` — the allowlist contract. Only keys declared here are injected.
- Set `minLength` via plugin options; default 8. Values shorter than the floor
  are matched only inside a `KEY=value` assignment, never as a bare substring —
  a short value would otherwise collide with ordinary identifiers and file paths.

## Agent usage contract

- Secrets are injected into shell **child-process** environments; reference them
  as `$KEY_NAME` in shell commands. Values are never visible to the model by design.
- Never read `.env`; it is denied to tools. Key NAMES are listed in every denial message.
- MCP tools do NOT receive injection — use the native shell tool for secret access.
- `secret://` URIs in `.env` are not yet resolved: the key is skipped with a warning.
- Only keys declared in `.env.example` are injected.

## Scope limit (design §17)

Output redaction protects the **model-visible channel** only. It does **not**
stop a malicious command from sending a secret directly over the network
(egress is out of scope; a future version would add network/domain policy).
`shell.env` intentionally hands real secret bytes to the child process.

## Development

```sh
bun run build       # tsc -> dist/
bun run typecheck   # tsgo --noEmit
bun test         # run the plugin test suite
bun pm pack         # verify the publishable tarball
```
