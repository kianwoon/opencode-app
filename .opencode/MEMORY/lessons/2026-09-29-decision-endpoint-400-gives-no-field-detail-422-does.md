# A decision endpoint's 400 carries no field detail; its 422 names the exact field — so a 400 is an unsupported-KEY error and a 422 is an unsupported-VALUE error, and they bisect differently

- **Date**: 2026-09-29
- **Type**: lesson

## Pattern

Probing a JSON decision API with a hand-built payload returned `400 {"detail":{"error_type":"api_usage_error","message":"Invalid request."}}` — a generic message naming no field. The real client, with its own payload, returned 200. Bisecting the two shape deviations one at a time showed the discriminator was the question TYPE, not the `state` shape: swapping only the question type moved the error from 400 to 422, and the 422 then named the offending path precisely (`Input should be a valid dictionary` at `["body","questions","<id>","choice","criteria"]`).

## Fix

Treat a bare 400 as "the request has a key or discriminator the API does not recognise" and a 422 as "a key is recognised but its value is the wrong type or shape". When a hand-built payload 400s while the real client's does not, diff the payload's TOP-LEVEL DISCRIMINATORS (the per-item `type` field, the envelope keys) before touching nested value shapes — the 400 points at the discriminator, and a nested fix will not move it. Also copy a real caller's payload shape verbatim rather than inventing one; a hand-built payload that omits a per-item type silently becomes a request for an unsupported type.

## Acceptance gate

A future agent handed a bare 400 from this endpoint can name the likely cause (an unsupported top-level discriminator) without re-bisecting, and knows the 422 body is the one that carries the field path.
