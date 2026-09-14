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
