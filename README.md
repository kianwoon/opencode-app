<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>

<p align="center"><b>The AI coding agent, upgraded into an AI harness.</b></p>
<p align="center">A fork of <a href="https://github.com/anomalyco/opencode">anomalyco/opencode</a> with a built-in harness layer: scheduled tasks, runaway-loop and stall guards, task-aware effort routing, cache-safe context control, workflow orchestration, verification gates, and durable runtime state.</p>

<p align="center">
  <a href="https://github.com/kianwoon/opencode-app/releases"><img alt="Latest fork release" src="https://img.shields.io/github/v/release/kianwoon/opencode-app?style=flat-square&label=fork%20release" /></a>
  <a href="https://github.com/anomalyco/opencode"><img alt="Upstream" src="https://img.shields.io/badge/upstream-opencode-blue?style=flat-square" /></a>
</p>

---

## Why This Fork

Upstream opencode is a capable agent loop surrounded by providers, tools, and
permissions. This fork turns that agent loop into a **harness** — a control
plane that manages context, intelligence allocation, orchestration, and
verification around every turn. All enhancements are implemented in-process
(no external meta-harness), staying upstream-mergeable.

## Unique Features

### ⏰ Scheduled Tasks (default ON)

Cron-scheduled sessions that run without you. Tasks are declared with a 5-field
cron expression (or `daily`/`hourly`/… presets) plus a prompt; the scheduler
fires them on time, claims due rows durably, and skips (or queues behind) a
session that is already busy. The model can create tasks itself with the
`schedule_task` tool, and the sidebar's Tasks section manages them.

```text
User: "review open PRs every weekday at 9am"
  → schedule_task  cron: "0 9 * * 1-5", prompt: "review open PRs, summarize risks"
  → scheduler fires on time → fresh session runs the prompt → run history kept
```

### 🛑 Runaway Loop Guards (default ON)

Two layers stop degenerate sessions without killing healthy long work:

- **Step bound** — every agent is capped at 1000 provider turns (per-agent
  `steps` config wins). Near the cap the tools are physically removed and a
  wrap-up prompt injected, so the session salvages itself with a final answer
  instead of erroring mid-work.
- **Turn-fingerprint interceptor** — identical consecutive turns are detected
  by content hash: 3 identical turns inject a visible warning, 6 strip tools
  and force a wrap-up, 10 hard-stop the loop with a persisted error.

### 🛡️ Idle Stall Guard (default ON, 180s)

Provider streams that go silent mid-turn are aborted after 180s of
no bytes — but strictly idle-based: **no total-time limit ever applies**, so
long healthy reasoning turns cannot be interrupted. Stalls raise a distinct
`ChunkStallError`, are retried with backoff by the normal bounded schedule,
and log a WARN with the stall duration. Per-phase escape hatches:
`timeout: false`, `chunkTimeout: false`, `headerTimeout: false`.

### ⚡ Workflow DAG Engine (default ON)

Multi-step pipelines as parallel subagent graphs. The model declares steps and
dependencies with the `workflow` tool; the engine runs independent steps
concurrently (event-driven, concurrency-capped), skips dependents of failed
steps, reports per-step outcomes, and detects deadlocks. Admission validation
(cycles, duplicate/missing deps, step cap, unknown agents) fails fast at both
the tool and the dispatch boundary.

```text
User: "run lint and tests in parallel, then commit if both pass"
  → PLAN    model lays out steps + dependencies
  → ORCHESTRATE  one workflow call; lint ∥ tests run concurrently
  → REACT   per-step summary; model fixes failures or commits
```

### 🧠 Task Assessor + Effort Governor

Every task boundary is profiled by cheap heuristics (complexity, risk domains —
zero LLM cost). Complex tasks **start** at medium reasoning effort,
complex+risky at high — no wasted turns discovering difficulty. The model can
still escalate via a `request_effort` tool (monotonic, capped). Never lowers a
user-pinned effort. Risky tasks get a "verify blast radius" system notice.

### 🗜️ Context Optimizer (KV-cache-aware pruning)

Compresses the conversation before each request **without wrecking the
provider cache**: under budget it is a strict no-op (byte-identical prefix =
max cache hits); over budget it prunes the minimum needed, nearest the
protected tail. Reasoning is always stripped; token estimation is CJK-aware;
live telemetry tracks hit rate and tokens saved (~90% hit rate in daily use).

### 🪟 Context Governor

Token-efficient turns for the runner: per-agent context budgets for
compaction, per-agent tool-catalog visibility (trim schema overhead), and a
repo-index system context source that surfaces repository structure through
the same delta-updated, epoch-persisted pipeline as other context.

### ✅ Verification Gate (opt-in)

After a task finishes, a pure risk detector (sensitive paths, destructive
prompts, broad refactors) can trigger **one reviewer subagent pass** whose
findings are injected back before the session goes idle. Enable with
`OPENCODE_EXPERIMENTAL_VERIFICATION=true`.

### ⏰ Followup Delivery (V2 sessions)

Durably admitted prompts with a delivery time: `delivery: "followup"` +
`deliverAt` keeps the input pending until its time passes, then promotes it at
the idle boundary. The execution scheduler wakes the session when it is due;
the database stays the source of truth.

### 💾 Durable Background Job Records

Background job lifecycle transitions persist best-effort to a `background_job`
table (never breaks live work). Restarts sweep stale "running" rows to
cancelled ("interrupted by restart"); `list`/`get` merge live entries over
recorded history.

### 🔎 Honest Failure Semantics

Aborts are classified as aborts (not mystery `UnknownError`s), user-initiated
subagent cancels report "Subagent cancelled", and early stream teardowns emit
diagnosable telemetry instead of failing silently.

### 🚀 Performance Pass

Context- and IO-efficiency work that keeps turns fast as sessions grow:

- **Read-only tool result cache** — repeated read-only calls in a session skip
  canonical execution entirely.
- **Watcher dirty-set staging** — file snapshots stage from watcher dirty sets
  instead of full rescans.
- **Post-compaction hydration boundary** — only retained messages hydrate
  after compaction, not the whole history.
- **tool_search demotion** — promoted tool definitions demote again under
  context pressure, keeping the catalog lean.

---

## Harness Architecture

The harness wraps every turn in four concentric stages — assessment, context
control, orchestration, and verification — over durable runtime state, and a
reliability shell around the provider stream itself.

```text
┌─────────────────────────────────────────────────────────┐
│                  HARNESS CONTROL PLANE                  │
│                                                         │
│user task --> Task Assessor --> effort/risk profile      │
│      │                                                  │
│      v                                                  │
│Effort Governor  <-- request_effort (model escalates)    │
│      │                                                  │
│      v                                                  │
│Context Engine                                           │
│├─ Context Optimizer (prune)                             │
│├─ Context Governor (budgets)                            │
│└─ System Context (deltas + epochs)                      │
│      │                                                  │
│      v                                                  │
│Orchestrator                                             │
│├─ single loop (simple tasks)                            │
│├─ workflow DAG (parallel subagents)                     │
│└─ Loop Guards (step bound + turn fingerprints)          │
│      │                                                  │
│      v                                                  │
│Verification Gate --> reviewer pass (opt-in)             │
│      │                                                  │
│      v                                                  │
│Durable State                                            │
│├─ inputs / jobs / events                                │
│└─ Task Scheduler (cron --> sessions)                    │
└──────┬──────────────────────────────────────────────────┘
       │
    single provider turn (LLM.stream)
       v
┌────────────────────────────────────────────────────────┐
│RELIABILITY SHELL (per stream)                          │
│├─ idle stall guard (180s idle, no total-time limit)    │
│├─ ChunkStallError --> bounded retry + backoff          │
│└─ repetition-loop guard                                │
└──────┬─────────────────────────────────────────────────┘
       │
       v
    providers / tools / MCP
```

Every element is in-process: plugins handle assessment/effort/pruning, core
handles orchestration/delivery/durability/scheduling. No external
meta-harness.

---

## Feature Flags

| Flag                                 | Default | Controls                      |
| ------------------------------------ | ------- | ----------------------------- |
| `OPENCODE_EXPERIMENTAL_WORKFLOWS`    | on      | Workflow DAG engine           |
| `OPENCODE_EXPERIMENTAL_VERIFICATION` | off     | Automatic reviewer gate       |
| `experimental.workflow_concurrency`  | 4       | Parallel workflow steps       |
| per-agent `steps` config             | 1000    | Max provider turns per agent  |
| `timeout` / `chunkTimeout` / `headerTimeout` | 180000 | Provider idle stall guard (ms; `false` disables a phase) |

## Releases (macOS Apple Silicon)

Fork releases are published on the
[releases page](https://github.com/kianwoon/opencode-app/releases) with a
prod-channel desktop app whose embedded server channel is machine-verified
before publishing:

| Release                                                                                  | Highlights                                                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [v1.18.25-fork.5](https://github.com/kianwoon/opencode-app/releases/tag/v1.18.25-fork.5) | Scheduled tasks, runaway loop guards, performance pass                  |
| [v1.18.25-fork.4](https://github.com/kianwoon/opencode-app/releases/tag/v1.18.25-fork.4) | Idle stall guard (default ON), plugin loading fixes                     |
| [v1.18.25-fork.3](https://github.com/kianwoon/opencode-app/releases/tag/v1.18.25-fork.3) | Context governor, abort handling                                        |
| [v1.18.25-fork.2](https://github.com/kianwoon/opencode-app/releases/tag/v1.18.25-fork.2) | Review hardening, honest cancel reporting                               |
| [v1.18.25-fork.1](https://github.com/kianwoon/opencode-app/releases/tag/v1.18.25-fork.1) | Workflow engine, effort governor, context optimizer, Phase 3 durability |

The full plan and rationale live in
[harness-enhancement-plan.md](./harness-enhancement-plan.md).

---

## Everything From Upstream

This fork tracks anomalyco/opencode (`merge-v1.18.24-25` base). Upstream
features all work unchanged:

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

### Desktop App (BETA)

Also available as a desktop application from the
[upstream releases page](https://github.com/anomalyco/opencode/releases) or
[opencode.ai/download](https://opencode.ai/download). This fork publishes its
own macOS-arm64 desktop builds on
[our releases page](https://github.com/kianwoon/opencode-app/releases).

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

### Documentation

For upstream configuration and usage,
[**head over to the docs**](https://opencode.ai/docs).

### Contributing

See upstream [contributing docs](./CONTRIBUTING.md). Fork-specific changes are
documented in [harness-enhancement-plan.md](./harness-enhancement-plan.md).

---

**Upstream community:** [Discord](https://discord.gg/opencode) |
[X.com](https://x.com/opencode)

_This fork is not built by the OpenCode team and is not affiliated with them._
