# @dsh-external/dsh-dog

> **v1.0.0 (stable)**: verification judgment has exactly two kernels — host-registered **scripts** (programmatic) and a single natural-language **instruction** (agentic). Workspaces, scheduling (watermark parallelism, programmatic leaves run unqueued), inheritance (terminal-run leftovers included), and orphan recovery (host restart → cancelled + inheritable settlements) are all settled. Protocol `schemaVersion` remains `0.9`. See [docs/architecture-0.9.md](docs/architecture-0.9.md) and [docs/CHANGELOG.md](docs/CHANGELOG.md).

DoG (DAG of Goals) is the first DeepSeek Harness prototype for graph-structured goals with trusted, snapshot-bound verification. The v0.1 boundary is intentionally verification-first: it validates and runs pre-existing artifact checks, but does not yet execute agent work or shell commands.

Read [`SPEC.md`](./SPEC.md) for the current contract. The specification is committed separately from implementation changes so design corrections remain visible in git history.

## Build and install

```sh
pnpm install
pnpm run check

# Profiles are independent; install only the surfaces that should expose DoG.
dsh plugin --profile web add "$PWD"
dsh plugin --profile headless add "$PWD"
dsh --profile headless --dump-config
```

The plugin's artifact access is configured **once, user-level**, in `~/.dsh/settings.yaml` under the `dog:` namespace — shared by every profile and not coupled to any profile patch:

```yaml
dog:
  artifactRoots:
    - { id: workspace, path: /absolute/approved/workspace }
  artifactBindings:
    - { id: deck, rootId: workspace, relativePath: deck.pptx }
  storageDirectory: dog
```

Profile patches must not contain `dsh-dog` configuration; the `dog:` settings section is the single source of truth (changed + restarted by the host, never by an agent).

The plugin exposes `dog_validate`, `dog_create`, `dog_run`, and `dog_status`. Leaf verifiers declare a sandbox-relative `path`; they cannot supply or escape the configured sandbox root. `dog_create` captures immutable bytes content-addressed, and `dog_run` verifies those bytes rather than the later live file.

In the web profile, the bundle adds a `DoG Graph` launcher through DSH's `shell.overlay` slot. The read-only debugger polls `GET /dog/api/snapshot` and shows immutable graph revisions, run history, containment/dependency edges, failure propagation, and verifier evidence without exposing artifact bytes. Start it with `dsh --profile web`; graph creation and execution still use the model-facing tools above.

An end-to-end loader smoke test uses the headless profile after configuration:

```sh
dsh --profile headless "Create a DoG for the configured deck artifact, run it, then read its status."
```

## Agentic CI skill (v0.2)

The canonical end-user skill for the agentic CI surface (tool set, v0.2 graph
schema, failure propagation, inherited semantics, trusted host facts) lives in
[`docs/skills/dog-v02-agentic-ci/SKILL.md`](./docs/skills/dog-v02-agentic-ci/SKILL.md).
This file is the single source of truth; the copy installed per-user in
`~/.dsh/skills/` must be re-synced from it after every change:

```sh
mkdir -p ~/.dsh/skills/dog-v02-agentic-ci
cp docs/skills/dog-v02-agentic-ci/SKILL.md ~/.dsh/skills/dog-v02-agentic-ci/SKILL.md
```

## v0.1 boundary

This release validates graphs and verifies pre-existing files. It deliberately does not execute agent work, run model-authored commands, create worktrees, perform semantic merges, or automate human review. Those later layers must preserve the acceptance-plan and immutable-snapshot trust boundary in [`SPEC.md`](./SPEC.md).
