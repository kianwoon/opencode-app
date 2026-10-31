import { Orchestration } from "@opencode/schema/orchestration"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"

// These paths are read by the Orchestration settings panel over plain fetch.
// Keep them stable: the panel does not use the generated client for them.
export const OrchestrationGroup = HttpApiGroup.make("server.orchestration")
  .add(
    HttpApiEndpoint.get("orchestration.effortRouter", "/global/effort-router", {
      success: Orchestration.EffortRouterConfig,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "orchestration.effortRouter.get",
        summary: "Get resolved effort-router config",
        description:
          "Read the resolved task-effort-router configuration (Jev tool routing, guardrail bands, risky tools).",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("orchestration.jevVerdicts", "/global/jev-verdicts", {
      query: Orchestration.JevVerdictsQuery,
      success: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "orchestration.jevVerdicts.list",
        summary: "List recent Jev verdicts",
        description: "Tail the newest effort-router decision records (newest first).",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("orchestration.gateConfig", "/global/gate-config", {
      success: Orchestration.GateConfig,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "orchestration.gateConfig.get",
        summary: "Get resolved context-gate config",
        description:
          "Read the resolved context-gate configuration (scoping, summarization, compaction triage) from context-gate.json.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("orchestration.gateConfigUpdate", "/global/gate-config", {
      payload: Orchestration.GateConfigUpdateInput,
      success: Orchestration.GateConfig,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "orchestration.gateConfig.update",
        summary: "Update context-gate config",
        description:
          "Update the writable context-gate toggle (compaction triage) in context-gate.json, preserving all other keys.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "orchestration", description: "Global orchestration settings routes." }),
  )
