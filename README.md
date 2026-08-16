# agentic-skill-shared-reference-vendoring

A general-purpose tool that vendors shared reference documents into the skills of a skill
repository: it distributes each document deterministically and guarantees that every
distributed copy is byte-identical to its canonical source.

Those two responsibilities are the whole scope:

- **Distribution** — expand canonical shared documents into per-skill vendored copies by
  deterministic generation.
- **Identity assurance** — prove, via content digests, that vendored copies match their
  canonical source and detect any unapproved drift.

Compatibility judgment and regression detection are explicitly out of scope. A digest can
prove that a copy is identical to its source; it cannot prove that a new version of a
document is compatible with the skills that depend on it. That judgment belongs to the
consuming repository's own regression machinery.

The tool is not locked to any particular repository. It is implemented in Deno/TypeScript
and ships as a single `.ts` source file that consumers sync at a fixed digest and run with
`deno run` — no compiled binary, so the distributed artifact needs no build-reproducibility
verification of its own.

## Status

The v1 design has converged (see `docs/spec/`); implementation has not started yet. See
`PROJECT.md` for commands and layout.
