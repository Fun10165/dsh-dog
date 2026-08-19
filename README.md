# @dsh-external/dsh-dog

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

The bundled profile patch registers the plugin with no artifact access. The profile owner must add approved roots and file bindings to that profile's user patch before a graph can reference them:

```yaml
- id: dsh-dog
  config:
    artifactRoots:
      - { id: workspace, path: /absolute/approved/workspace }
    artifactBindings:
      - { id: deck, rootId: workspace, relativePath: deck.pptx }
```

The plugin exposes `dog_validate`, `dog_create`, `dog_run`, and `dog_status`. A graph may name `deck`; it cannot supply or override the filesystem path. `dog_create` captures immutable bytes, and `dog_run` verifies those bytes rather than the later live file.

An end-to-end loader smoke test uses the headless profile after configuration:

```sh
dsh --profile headless "Create a DoG for the configured deck artifact, run it, then read its status."
```

## v0.1 boundary

This release validates graphs and verifies pre-existing files. It deliberately does not execute agent work, run model-authored commands, create worktrees, perform semantic merges, or automate human review. Those later layers must preserve the acceptance-plan and immutable-snapshot trust boundary in [`SPEC.md`](./SPEC.md).
