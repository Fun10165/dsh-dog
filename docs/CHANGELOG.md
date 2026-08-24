# Changelog

## v1.0.0 (2026-08-23) — stable

DAG of Goals (dsh-dog) reaches 1.0 after the v0.9 judgment-layer rework and a
full end-to-end hardening pass against live web/headless runs. Protocol
`schemaVersion` stays `0.9`; this entry tracks product version 1.0.0.

### Setup & configuration
- **workspaceRoot settings race fixed**: the engine now re-reads the live
  settings scope at construction instead of freezing the registration-time
  snapshot (schema default `dog/workspace` could win when the settings file
  loaded asynchronously, making every capture resolve against a missing root).
- **Programmatic script names resolve without `.js`** (`resolveScriptPath`):
  `"script": "slop-phrases"` resolves `slop-phrases.js` in the library.
- **Script library, docs**: `~/.dsh/dog/scripts/` shipped with
  `slop-phrases.js`, `file-non-empty.js`.

### Judgment protocol
- **Settlement contract unified**: verifier subagents are told to write
  `{"verdict": "pass|fail|inconclusive", "evidence": …}` and `parseSettlementFile`
  reads exactly that (pre-0.9 `settlement`/`observation` still accepted as
  fallback). Previously the prompt and parser disagreed, so every agentic
  verdict settled `inconclusive` → `needs_human`.
- **Whole-object assertion events report the real verdict** (pass/fail/
  inconclusive) instead of an unconditional `verifier_passed`.

### Scheduling & composition
- **True watermark parallelism**: any finished verifier immediately refills
  its slot; the old wave barrier (wait for the whole batch, then start the
  next) is gone.
- **Programmatic leaves are unqueued**: the concurrency budget gates only
  agentic (model-backed) verifiers; script-based leaves run as soon as their
  dependencies are satisfied.
- **`relationTruth` honors inherited results**: an inherited `failure` is a
  failure (`verification.passed` drives the truth value), an inherited
  `needs_human` is `needs_human`; dependency gates use `succeededState`.
- **Whole-object assertions skip when the subtree already failed** (a
  demote-only merge cannot repair it — no wasted agentic review).
- **`dependsOn` semantics documented and drawn correctly**: `source` depends on
  `target`; the UI arrow runs target → source.

### Persistence & life-cycle
- **Leaf settlements persist immediately** (`saveProgress` on `goal_settled`)
  instead of leaving the goal column `running` until the composite phase.
- **Verifier workspaces outlive their verifier**: released at run teardown
  (`releaseAll`), so late settlement writes are still read (generous 15s grace
  window); also fixes the never-released composite-assertion workspace leak.
- **Orphan recovery at host boot**: any persisted run left `running` by a dead
  host is cancelled immediately (run level *and* goal level); its settled
  leaves remain inheritable by the next run of the same graph.
- **Inheritance source broadened** to any non-running prior run (completed,
  cancelled, failed), so restarted hosts resume leveraging prior settlements;
  the half-dead `resumeRun` path was removed in favor of inheritance.

### UI (debugger)
- `RUNTIME_PHASES` gains `verifier_released` (was breaking goal-trace parsing
  → "Context unavailable").
- Snapshot parses `passed: null` (legitimate for unsettled/inconclusive) and
  filters pre-0.9 graphs out of the panel (they poisoned the whole snapshot).

### Tests
- 33 engine/plugin tests, including regression guards for: watermark
  parallelism (temporal ordering), programmatic unqueued execution,
  inherited-failure propagation, skipped assertions on failed subtrees,
  inheritance from cancelled prior runs, and settlement protocol.

### Known limitation (honest disclosure)
- Agentic leaves are **single-shot**: one isolated verifier per judgment, no
  re-check or voting against single-judge blind spots (the v0.2-deferred
  calibration item remains unimplemented). Removing the evidence schema also
  removed structural comparability, so "reproducible" holds strictly for
  programmatic kernels; agentic verdicts are anchored (object + instruction
  hash) but not model-stable. Use programmatic kernels for deterministic
  gates and treat agentic verdicts as evidence plus (high-stakes → human
  confirmation is in the loop via `needs_human`).

The judgment-model statement (two kernels; no registry, no parameter
allow-lists, no evidence schema ids) is carried from v0.9; see
[docs/architecture-0.9.md](docs/architecture-0.9.md).
