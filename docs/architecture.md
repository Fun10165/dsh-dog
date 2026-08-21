# DoG v0.2 — Architecture

This document is the executable-layering counterpart of [`SPEC.md`](../SPEC.md). It answers three questions:

1. **What is the module structure**, and which nodes are programs vs agents vs humans (§1, `diagrams/architecture.svg`);
2. **What is exchanged across every boundary**, in what format, and which schema governs it (§2, `diagrams/exchange.svg`);
3. **How one run flows end to end**, and who executes each stage (§3, `diagrams/flow.svg`).

Color legend (all diagrams):

| Color | Meaning |
|---|---|
| Green | Human (project owner) |
| Purple | LLM Agent session (context-isolated) |
| Blue | Program (host code, deterministic) |
| Orange | Development agent (outside DoG, abstracted) |
| Teal | Existing CI pipeline (outside DoG) |
| Gray | Durable storage |

---

## 1. Module structure

`diagrams/architecture.svg`

Three layers, one boundary:

- **Outside — development side**: the Development Agent (abstracted) and the Existing CI pipeline. Neither appears inside DoG. The only couplings are the artifact bind path (in) and `dog_run` / `dog_status` reports (out).
- **Outside — acceptance side**: the Human project owner. Always owns the objective and confirms the graph.
- **DoG core (DSH plugin)**:
  - **Tool surface** (`dog_validate`, `dog_create`, `dog_run`, `dog_status`, `dog_bind_agent`, `dog_delegate_agent`) — programs;
  - **Schema layer** — the five `schemas/schema-0.2/*.json` contracts. Every payload is validated here before parsing or persistence;
  - **Compiler** (graph parser + static rules incl. the programmatic-subtree rule, acceptance-plan compilation, verifier contract resolution) — program;
  - **Scheduler** (dependency gates, isolated-workspace pool, revalidate selection) — program;
  - **Verifier execution**:
    - *deterministic contracts* (`file.exists` etc.) — program inside an isolated workspace;
    - *agentic contracts* (`vision.overlap` etc.) — Verifier Agent (LLM session, context-isolated, `allowedTools` only) inside an isolated workspace;
  - **Grounding extractors** — programs (host-registered), the only source of `gmDigest`;
  - **Planner / Coverage Reviewer** — LLM agents used at graph time, not at run time;
  - **Storage** (graphs, runs, verifications, artifacts, runtime-events) — programs, append-only + content-addressed;
  - **WebUI debugger** — read-only program over the snapshot RPC.

Invariant to keep visible: the only agent the *run* spawns is the Verifier Agent, and all other run-time stages are programs.

## 2. Data exchange links

`diagrams/exchange.svg`

Five normative payloads, each governed by one JSON Schema; plus three content-addressed byte flows.

| Exchange | Producers → Consumers | Format | Schema |
|---|---|---|---|
| Graph input | Planning agent → Compiler | JSON | `graph.schema.json` |
| Run record | Engine → Storage / Status reader | JSON | `run.schema.json` |
| Verification record | Verifier execution → Storage | JSONL (one object/line) | `verification.schema.json` |
| Runtime event | Engine → Storage | JSONL (one object/line) | `runtime-event.schema.json` |
| CI report | Engine → Dev agent / External CI | JSON | `report.schema.json` |
| Artifact snapshot | Bind path → Artifact store | bytes | content-addressed (`sha256`) |
| Evidence objects | Verifier Agent → Artifact store | bytes + JSON references | contract `evidenceSchemaId` |
| GM | Extractor → Engine → run record | JSON (normalized) → `gmDigest` | extractor schema + `gmDigestAlgo` |

Rule: a payload that does not validate against its declared schema is rejected before it is parsed or persisted (fail closed). Structure validation is program-side; `date-time` fields use the standard `format` and need a format-aware validator.

## 3. Run flow

`diagrams/flow.svg`

The flow is deliberately staged so that failure settlement never stops unrelated verification (§9.1): propagation is about *results*, scheduling is about *maximizing completed verification*.

```text
draft (human + planning agent) → coverage_review (agent) → confirm (human)
→ compile (program) → capture (program) → revalidate_select (extractors + program)
→ verify (scheduler: deterministic program / agentic Verifier Agent, isolated workspaces)
→ recompute (program, all affected paths) → human_review (if needed)
→ report (program, machine-readable) → terminal (program)
→ developer consumes report → submits new artifact → new run
```

Key facts per stage (details in `§16` of the SPEC):

- `revalidate_select` decides re-run vs `inherited` by GM digest + contract version only; graph edges never decide revalidation, and `non_programmatic` leaves always re-run.
- `verify` runs every ready node in its own mutually exclusive workspace; a failed node never cancels unrelated ready nodes.
- `report` carries `revalidated` / `inherited` / `warning`; the threshold warning fires when a submission re-triggers more leaves than `revalidateThreshold`.
- The Development Agent never schedules anything, never edits the graph, and receives either the `dog_run` summary or the full `dog_status` report.
