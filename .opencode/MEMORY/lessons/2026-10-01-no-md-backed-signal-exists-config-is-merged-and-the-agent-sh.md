# No md-backed signal exists: /config is MERGED and the agent shape has no source field

- **Date**: 2026-10-01T23:00:43+0800
- **Type**: lesson

## What happened

To render a config row read-only when the agent's .md shadows it, the app needs an md-backed signal. It does not exist. (1) The v1 /agent shape is identical for every agent - capabilities,color,description,hidden,mode,model,name,native,options,permission,prompt,skills,steps,temperature,tools,topP,variant - with NO source/path/file field, and ConfigAgent.load() (packages/opencode/src/config/agent.ts:24-28) records no origin. (2) 'native' does NOT separate them: it is true only for built-ins (build, compaction, general, plan, summary, title) and false for the md-backed hands AND for config-only agents (brain, research, duplicate-pr, triage). Worse, build.md and plan.md exist on disk while their agents are native=true, so native does not even mean 'no md file'. (3) Comparing config vs runtime value FAILS by construction: config.ts:482-483 merge ConfigAgent.load(dir) as the 2nd arg of mergeDeep, so /config ALREADY returns md-won values and any divergence-based test can never fire. FIX: thread the origin through the schema - ConfigAgent.load sets a source marker on each md-derived entry, Agent.Info declares it, regenerate the SDK, and the panel keys read-only off that marker.

## Root cause / fix

Never infer config-vs-file precedence from the merged config the server returns; read the unmerged shape or add an explicit origin marker. Acceptance: /config for an md-backed agent with a DIFFERENT description in opencode.json still reports the md value (proving merge), and the agent shape carries a per-agent source field; packages/app typecheck exit 0 after bun ./script/build.ts from packages/sdk/js.
