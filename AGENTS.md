# Brownie Agent Instructions

## Project identity

Brownie is a new repository and an independent implementation.

Brownie is not a fork of Zoo Code or ZooCodeCustom. Do not copy source code from those repositories. Treat them as reference sources for observable behavior and selected wrapper functionality only.

Brownie targets Code-OSS as a VSIX extension surface and uses Custom Agent UI. The primary execution engine is a Rust runtime.

## Brownie v0 baseline

Brownie v0 is defined by `docs/specifications/brownie-scope-v0.md`.

Core rules:

1. Keep the VSIX thin. Runtime behavior belongs in Rust.
2. Implement the agent loop as an explicit state machine.
3. Treat AgentModes as an external Mode Pack, not as vendored source.
4. Compile AgentModes into runtime-enforced policies.
5. Runtime permissions override LLM instructions.
6. Apply sliding window truncation to the prompt view, not to the persisted ledger.
7. Separate llama-server wrapper from the generic LLM client.
8. Separate Qdrant wrapper from the codebase indexer.
9. Retrieval must not be vector-only.
10. Do not automatically apply Mode Pack updates to running tasks.

## Current phase authority

Phase 0 is complete. Current implementation authority comes from the external
Brownie phase-loop controller state, `docs/architecture/product-charter.md`, and
`docs/architecture/phase-value-manifest.json`.

The Phase 0 constraints below are historical bootstrap constraints. Do not apply
them as current blockers to accepted M/R phases such as M9 runtime codebase
indexing work.

## Operational roles and delegated execution

The implementation, review, merge, and exceptional delegated-executor roles
are deployment-time roles. Resolve their identities from the active deployment
and GitHub evidence for each run; never encode account, organization, or agent
names as a default, allowlist, or completion condition.

For every implementation PR, record and independently verify the observed PR
author, CI result, reviewer, and merge actor. CI success is not completion.
When the active operator holds the review role, they must inspect, approve, and
merge a green PR rather than report a fictitious external-review wait.

Exceptional delegated execution is valid only for one explicitly identified
TODO. Its durable receipt must state the grant reason and evidence, TODO ID,
allowed scope, prohibited scope, required verification, and issuance time. It
remains valid only until both of these are evidenced for that same TODO:

1. The implementation PR is merged.
2. The TODO is consumed in the live queue with its completion evidence.

Do not reuse, transfer, or broaden a delegation to another TODO. A new TODO
requires a new explicit grant and receipt. Treat a missing receipt, an expired
receipt, a mismatched TODO, or a missing PR/TODO completion half as a blocked
state, not as permission to continue.

Keep implementation, PR creation, CI, review, merge, TODO consumption, and
post-merge runtime verification as separate audit states. Do not close a task
or resume a loop until every applicable state has evidence. Recovery work must
identify the causal failure and add a generalized guard and regression test;
restarting the same failed state is not a recovery.

## Historical Phase 0 constraints

Phase 0 is limited to repository bootstrap:

- Rust workspace skeleton
- VSIX workspace skeleton
- specification and architecture documents
- stdio JSON-RPC boundary design
- minimal `runtime.status` target

Do not implement the full agent loop in Phase 0.
