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

The host ships an identical broker **enabled by default**. If you install this
standalone package while the built-in is still active, both run (duplicate
injection and redaction — wasteful, not a leak). Disable the built-in:

```sh
export OPENCODE_DISABLE_SECRET_BROKER=1
```

The plugin prints a one-line `console.warn` at startup when it detects the
built-in flag is unset.

## Configuration

- `.env` — real secret values (never read by the model; denied to tools).
- `.env.example` — the allowlist contract. Only keys declared here are injected.
- Set `minLength` via plugin options; default 8. Values shorter than the floor
  are matched by word boundary only.

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
