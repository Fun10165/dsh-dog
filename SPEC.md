# DoG — DAG of Goals

Status: `draft-v0.1`

This document is the implementation contract for the first DeepSeek Harness plugin slice. It is intentionally narrower than the long-term vision: anything not listed as implemented below is deferred rather than silently approximated.

## 1. Problem and invariants

DoG represents a non-formal root objective as a directed acyclic graph of goals. A graph contains hierarchical goal membership and explicit cross-goal dependencies. In v0.1, a leaf is complete only when its independently bound verifier passes an immutable artifact snapshot; a composite is complete only when its required parent relations and restricted completion expression settle successfully.

The implementation must preserve these invariants:

1. A graph is acyclic over the union of containment and dependency edges.
2. A node may be shared by multiple composite goals. No algorithm may assume one parent.
3. Failure tolerance belongs to a parent-child relation, not to the shared child. Each incoming relation is evaluated independently.
4. A verifier never accepts a path, command, verifier name, scope, or snapshot selected by the producer of the artifact or by a model-authored evidence object.
5. Every successful verification is bound to an immutable artifact snapshot and an immutable acceptance plan. A later artifact version cannot inherit an earlier pass.
6. The root goal is always a hard constraint. Hard constraints are not compensable by soft-goal scores; an explicitly allowed `partial_success` remains distinct from `success`.
7. Root execution has honest terminal states, including `failure`, `infeasible`, `cancelled`, and `needs_replan`; the engine never fabricates success or waits forever for an impossible goal.
8. Boolean completion expressions are parsed and type-checked into a restricted AST. No `eval`, dynamic import, shell command, or arbitrary expression interpreter is allowed.
9. Human review is a normal terminal/control transition, not an exception hidden inside a retry loop.

## 2. Scope of v0.1

### Implemented in the first plugin slice

- Parse and validate a JSON DoG graph.
- Validate containment/dependency references, duplicate IDs, acyclicity, expression references, and parent-edge semantics.
- Compile a graph into an immutable acceptance plan.
- Capture a content-addressed snapshot of a bounded local artifact file.
- Run trusted, built-in atomic verifiers against the system-bound snapshot.
- Evaluate composite completion rules through a restricted Boolean AST.
- Recompute every affected upstream composite independently for every incoming parent edge.
- Persist graph definitions, execution records, artifact manifests, and verification records under the active DSH home.
- Expose model-facing tools for graph creation, validation, deterministic verification, and status inspection.
- Register and dispose all DSH tool effects through the normal Cordis plugin lifecycle.

### Deferred; must not be faked by v0.1

- Agent/session execution of goal work.
- LLM-generated or LLM-based verifiers.
- Git worktree creation and parent-owned semantic merge.
- Dynamic graph planning and recursive graph construction.
- WebUI graph rendering and live event transport.
- Arbitrary user-defined verifier code or shell commands.
- External artifact stores and distributed workers.
- Automatic retries and degradation execution policies.

The deferred features may consume the v0.1 persisted records later, but cannot weaken their trust or version rules.

## 3. Core vocabulary

- **Goal**: a node whose desired condition is represented by a verifier and/or a composition of child outcomes.
- **Leaf goal**: a goal with no containment children. In v0.1 it must have a trusted atomic verifier binding.
- **Composite goal**: a goal with one or more containment children and a completion rule. v0.1 evaluates that rule only and rejects composite verifier fields rather than silently ignoring them.
- **Containment edge**: `parent contains child`; it contributes the child's outcome to the parent's completion rule.
- **Dependency edge**: `source depends_on target`; target must be complete before source may be evaluated. It carries data/version dependencies but does not automatically make the target a containment child.
- **Parent relation**: the semantic object formed by one containment edge. It owns tolerance, requiredness, degradation policy, and merge policy for that particular parent-child use.
- **Acceptance plan**: a system-compiled, immutable binding of a goal to a verifier version, target artifact snapshot, exact scope, fixed parameters, and evidence schema.
- **Artifact snapshot**: an immutable, content-addressed byte representation of the exact file or artifact revision inspected by a verifier.
- **Evidence**: verifier-produced observations. Evidence is descriptive output, never authorization to choose what gets verified.
- **Affected upstream**: every composite reachable through reverse containment or dependency edges from a changed node; recomputation follows all paths, not one selected parent.

## 4. Graph representation

The external representation is JSON-compatible YAML if a future authoring layer wants YAML. v0.1 tools accept JSON values; no JavaScript is evaluated while parsing a graph.

```json
{
  "schemaVersion": "0.1",
  "id": "ppt-quality",
  "root": "root",
  "nodes": {
    "root": {
      "kind": "composite",
      "title": "Deliver an acceptable deck",
      "constraint": "hard",
      "completion": { "op": "all", "items": [
        { "op": "ref", "id": "file" },
        { "op": "ref", "id": "readable" }
      ] }
    },
    "file": {
      "kind": "leaf",
      "title": "The deck exists",
      "constraint": "hard",
      "verifier": { "id": "file.exists", "version": "1" },
      "verifierParams": { "artifactId": "deck" }
    },
    "readable": {
      "kind": "leaf",
      "title": "The deck is readable",
      "constraint": "soft",
      "verifier": { "id": "file.non_empty", "version": "1" },
      "verifierParams": { "artifactId": "deck" }
    }
  },
  "contains": [
    { "parent": "root", "child": "file", "required": true, "failure": "fatal" },
    { "parent": "root", "child": "readable", "required": true, "failure": "tolerable" }
  ],
  "dependsOn": []
}
```

### Node fields

- `kind`: `leaf` or `composite`.
- `title`: non-empty human-readable goal statement.
- `constraint`: `hard` or `soft`. The root must be `hard`; v0.1 records non-root softness but does not invent a soft-score model.
- `completion`: restricted AST, required for composites with children.
- `verifier`: a registry identifier and version only. It is not a module path, command, or model-supplied function.
- `verifierParams`: declarative parameters checked by the registry for the selected verifier. Parameters are copied into the acceptance plan before execution. The graph may refer to a host-bound `artifactId`, but may not select a filesystem root, path, command, or verifier implementation.

A leaf cannot declare a completion expression. A composite cannot be evaluated as complete while a required dependency is unresolved. Unknown fields are rejected in strict mode to prevent hidden execution directives.

### Parent-relation fields

- `required`: whether this child reference participates in the parent's required completion contract.
- `failure`: `fatal`, `tolerable`, or `degrade`. This is interpreted only by this parent relation.
- `degradeTo`: optional approved node ID used when `failure=degrade`; it must be a sibling relation explicitly present in the graph.
- `merge`: `none`, `parent`, or `human`. v0.1 accepts only `none`; later worktree execution may use parent-owned merge.

A shared child can therefore be fatal for one parent and tolerable for another. The child itself has no global `tolerable` flag.

Degradation applies only after the direct child settles as a failure. It never converts `needs_human` or another unresolved state into success merely because the fallback passed. If several required relations fail, any `fatal` relation dominates tolerable failures regardless of edge order. A degradation target cannot be the failed child itself.

### Dependency fields

- `source` cannot be evaluated before `target` reaches a terminal outcome allowed by the source's policy.
- `data`: optional list of named output fields to bind in a later version. v0.1 records the relation but does not execute arbitrary data expressions.
- Dependencies must not create a cycle with containment edges.

## 5. Restricted completion AST

The only legal completion operators are:

```json
{ "op": "ref", "id": "child-id" }
{ "op": "all", "items": [ /* boolean expressions */ ] }
{ "op": "any", "items": [ /* boolean expressions */ ] }
{ "op": "not", "item": /* boolean expression */ }
{ "op": "atLeast", "count": 2, "items": [ /* boolean expressions */ ] }
```

The parser enforces:

- no extra keys;
- non-empty `items` for `all`, `any`, and `atLeast`;
- integer `count` in `[1, items.length]`;
- every `ref` resolves to a containment child of the current composite;
- every expression evaluates to a boolean;
- bounded nesting and total node count from plugin configuration;
- no strings representing code, shell, paths, or JavaScript expressions.

The evaluator receives a map of already-computed child booleans. It never receives source text and never invokes an interpreter.

## 6. Acceptance and evidence trust boundary

### 6.1 Compilation

Before execution, the system/compiler—not the producer—creates an acceptance plan for every leaf:

```json
{
  "goalId": "file",
  "verifierId": "file.exists",
  "verifierVersion": "1",
  "artifactId": "deck",
  "rootBindingId": "workspace",
  "relativePath": "deck.pptx",
  "snapshot": {
    "artifactId": "deck",
    "snapshotId": "sha256:...",
    "exists": true,
    "byteLength": 1234,
    "sha256": "..."
  },
  "scope": { "kind": "file", "artifactId": "deck" },
  "params": { "artifactId": "deck" },
  "evidenceSchemaId": "file.exists/v1"
}
```

The host configuration, not the graph producer, maps `artifactId` to a root binding and relative path. The plan is deep-frozen in memory and persisted with those fields and an explicit file scope. The system resolves that mapping, canonicalizes the resulting path, and checks it against the approved root before snapshot capture. A path supplied in a child output or evidence object is ignored and cannot override the plan.

### 6.2 Snapshot lifecycle

1. The system resolves the host-bound artifact ID to its configured root and relative path.
2. It reads the bytes itself and computes a SHA-256 digest.
3. It writes or reuses an immutable content-addressed snapshot.
4. The verifier reads only that snapshot and the fixed plan parameters.
5. The verification record stores the snapshot ID and verifier version.

If the live file changes after capture, the record remains valid for the old snapshot but cannot be used to claim the new version passed. A new run must compile a new plan/snapshot.

### 6.3 Evidence rules

- Evidence is generated by the trusted verifier implementation.
- Evidence cannot select `verifierId`, path, command, scope, or snapshot.
- v0.1 verifiers are direct library functions; they do not execute child-provided commands and do not accept executable test source.
- A pass requires a verifier-specific result with a non-empty, schema-valid observation and the exact input snapshot ID.
- A generic `{ "passed": true }` object is never sufficient.
- A verifier that does not inspect the bound snapshot or cannot produce its declared observation fails closed.
- Verification records are append-only; a later record supersedes an earlier record only when it names a different run and snapshot.

Future custom verifiers require explicit registry installation and trusted code review. A graph cannot register one by naming a file, package, URL, or command.

## 7. Trusted atomic verifier registry

Each registry entry declares:

```ts
interface AtomicVerifierSpec {
  id: string
  version: string
  paramsSchema: DeclarativeSchema
  evidenceSchemaId: string
  verify(snapshot: ArtifactSnapshot, params: unknown): AtomicResult
}
```

The registry owns parameter validation, target selection, and evidence construction. The first entries are:

- `file.exists/v1`: exact bound file has a readable snapshot with non-zero metadata.
- `file.non_empty/v1`: exact bound snapshot byte length is greater than zero.
- `file.sha256/v1`: snapshot digest equals a fixed expected digest.
- `text.includes/v1`: UTF-8 snapshot contains a fixed expected string; invalid UTF-8 fails.

These are intentionally narrow. PPT-specific XML/rendering verifiers will be added only after their snapshot format, scope, and independent evidence contract are specified.

## 8. Status and terminal semantics

### Node states

`pending`, `running`, `success`, `failure`, `blocked`, `needs_human`, `cancelled`, `invalidated`, `partial`.

A successful leaf verification record carries the run ID, graph digest, artifact ID, snapshot ID, verifier version, and bounded observation. Composite results carry their state and reason. v0.1 does not claim separate dependency-output hashes because it executes no producer work; the graph digest plus immutable snapshot IDs are its complete reuse boundary.

### Root terminal states

- `success`: the restricted root completion expression is true and every required parent relation succeeds directly or through its declared degradation target.
- `partial_success`: the root is `partial` and deployment explicitly sets `allowPartialRoot`; v0.1 has no independent soft-score threshold.
- `failure`: a non-tolerable required relation fails, the root completion expression settles false under fatal policy, or partial root delivery is disabled.
- `infeasible`: the declared conditions cannot be met under available artifacts or capabilities.
- `needs_replan`: the graph or goal contract must change before execution can continue.
- `cancelled`: human or policy ended execution; partial records remain inspectable.

`needs_human` is an active control state, not a root success/failure claim. Human decisions may retry, edit the graph, approve a degradation allowed by the graph, or terminate. No decision is represented as an automatic pass.

## 9. Shared-node propagation and parent-owned merge

A node result is immutable and may feed multiple parents. After any result changes, the engine:

1. finds every reverse containment and dependency edge reachable from the changed node;
2. evaluates each incoming parent relation with its own `required`, `failure`, and degradation policy;
3. recomputes each affected composite's completion AST from the current child-result map;
4. applies the composite's own independent verifier/policy, if any;
5. continues until a fixed point or a human/terminal boundary;
6. recomputes the root from all affected paths.

There is no single `getParent()` operation.

When future work produces worktree candidates, the parent composite owns merge:

1. collect candidate artifact references from its direct children;
2. perform the configured merge policy in the parent's workspace;
3. capture a new post-merge snapshot;
4. rerun all parent acceptance plans whose scope intersects the merged artifact;
5. publish the merged artifact only after the parent-level checks settle.

A child cannot merge another child's worktree, and a pass from a pre-merge snapshot cannot authorize a post-merge artifact.

## 10. Lifecycle

The full DoG lifecycle is below. In v0.1, coverage review and human review are external control points; the plugin deterministically compiles, verifies, persists, and surfaces `needs_replan` rather than pretending to run an autonomous reviewer.

1. `draft`: author or planner supplies a graph.
2. `coverage_review`: an independent reviewer checks that the root objective, hard constraints, required artifacts, and obvious failure modes are represented. It may reject the draft; it cannot silently add goals.
3. `compile`: validate graph, resolve trusted verifier IDs, bind artifact scope, capture snapshots, and assign a graph revision.
4. `execute`: v0.1 only evaluates pre-existing artifacts; later versions execute child work.
5. `verify`: trusted verifiers produce records against fixed snapshots.
6. `recompute`: propagate results along every affected upstream path.
7. `human_review`: pause on root hard failure, uncertainty, coverage rejection, budget anomaly, or policy-required review.
8. `terminal`: persist an honest root terminal state and report evidence.

Coverage review and future LLM verification must use a context-isolated session. The isolated reviewer receives the original objective, the candidate graph, and explicit review rules—not the producer's private reasoning or self-authored test instructions.

## 11. Persistence

By default the plugin stores under `$DSH_HOME/dog/` (the directory name is configurable):

- `graphs/<graph-digest>.json`: immutable compiled graph revisions and acceptance plans;
- `graph-index/<host-safe-graph-key>.json`: latest-revision lookup for a graph ID; the indexed digest must be a lower-case SHA-256 value before it is used as a filename;
- `runs/<host-safe-run-key>.json`: execution state and terminal result;
- `artifacts/<snapshot-key>.bin|json`: immutable snapshot bytes and manifest;
- `verifications/<host-safe-run-key>.jsonl`: append-only verifier results.

Writes use temporary files plus atomic rename. Records contain schema versions and never contain credentials. A status read returns metadata and bounded error/evidence fields; it does not dump arbitrary session context.

## 12. DSH plugin surface in v0.1

Package: `@dsh-external/dsh-dog`.

The host plugin registers these model-facing tools through `ctx.tools`:

- `dog_validate`: parse and statically validate a graph without writing it.
- `dog_create`: validate, compile, resolve only host-bound artifact IDs, snapshot those artifacts, and persist a graph revision.
- `dog_run`: evaluate the trusted verifiers for a stored graph run and recompute all affected upstream nodes.
- `dog_status`: return a bounded graph/run status and verification evidence.

All tool arguments cross a model boundary and are validated. Model-authored graphs may reference only artifact IDs predeclared by host configuration; they cannot supply artifact roots or paths. The tools do not spawn shell commands.

The plugin exports `name`, `Config`, `inject`, and `apply` according to the DSH loader contract. `apply` registers effects with disposers and fails loudly for invalid configuration or missing required services.

## 13. Configuration

The initial deployment configuration is declarative:

```yaml
artifactRoots: []          # host bindings: [{ id: workspace, path: /approved/workspace }]
artifactBindings: []       # host bindings: [{ id: deck, rootId: workspace, relativePath: deck.pptx }]
storageDirectory: "dog"   # relative to DSH_HOME
maxGraphNodes: 256
maxExpressionNodes: 512
maxExpressionDepth: 64
maxSnapshotBytes: 67108864
allowPartialRoot: false
```

`artifactRoots` and `artifactBindings` are host-authored configuration, validated at plugin load, and are the only source of target paths. No model-authored graph can override them or introduce a new binding. A future permission integration may add user approval for new roots; v0.1 rejects them.

## 14. Security and failure policy

- Reject traversal, absolute paths outside approved roots, symlink escapes, duplicate IDs or dependency edges, cycles, self-degradation, unknown verifier IDs, malformed schemas, and oversized snapshots.
- Never use `eval`, `new Function`, dynamic imports from graph data, or shell interpolation.
- Redact credentials from errors and persisted evidence.
- Treat all model-authored graph fields, executor output, and evidence as untrusted data.
- On storage or snapshot mismatch, fail closed and require a new run.
- On a cost or timeout anomaly in future execution phases, enter `needs_human`; do not silently lower verification standards.

## 15. Explicitly deferred design decisions

The following remain open until a benchmark or real DSH integration supplies evidence:

- retry strategy and cost-aware scheduling;
- worktree allocation and conflict resolution details;
- LLM verifier calibration and voting;
- WebUI transport and graph layout;
- dynamic planning and graph migration;
- GitHub template repository format.

Changes to this document must be committed separately from implementation changes when possible. The commit history is the record of which parts of the design changed because the implementation exposed an unrealistic assumption.
