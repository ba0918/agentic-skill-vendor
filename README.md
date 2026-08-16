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

## Using it

```
deno run --allow-read --allow-write src/vendor.ts <command> [--root <path>]
```

| Command | What it does |
|---|---|
| `gen` | Writes the accepted contracts into every skill that declares them |
| `verify` | Checks the tree against the lock |
| `accept <contract-id>...` | Adopts the current text of the named contracts |
| `lint-selfcontain` | Checks that no skill points outside its own directory |
| `self-test` | Checks this file against the vectors embedded in it |

`--root` names the tree to work on and defaults to the current directory. The exit code is
`0` when there is nothing to report, `1` when violations were found (one per line on standard
output), and `2` for a configuration or usage error (described on standard error, with
nothing written).

`verify`, `lint-selfcontain` and `self-test` never write, so they can be given
`--allow-read` alone. Only `gen` and `accept` need `--allow-write`. Nothing needs network,
environment, or subprocess access.

### The tree it works on

```
contracts/<id>.md                              the canonical text of a contract
contracts/<id>/conformance/**                  its conformance tests, if it has any
skills/<name>/SKILL.md                         a skill, and what it declares
skills/<name>/references/vendor/<id>.md        the copy written into that skill
vendor-manifest.json                           the lock and the provenance record
```

Skills are the directories directly under `skills/`.

### Declaring a dependency

A skill names the contracts it depends on in its `SKILL.md` frontmatter, by id and nothing
else:

```yaml
metadata:
  contracts:
    - verdict-format
    - changelog-entry
```

Digests are not written here — they live in the lock. That separation is what keeps an
update to a contract out of the diff of every skill that reads it. Declaring a dependency on
a contract that has already been accepted needs no further approval: write the id and run
`gen`.

### Adopting a change to a contract

`accept` is the only thing that writes a resolution, and so it is the point at which a change
of contract text becomes approved. It reports what a reviewer needs:

```
accepted: verdict-format
  old-digest: sha256:5486c28f…
  new-digest: sha256:872df2c0…
  dependents: review-writer
```

There is no accept-all: approval means naming what is being approved.

### Verifying a copy you synced

A consumer pins this file by digest and checks it in two steps:

1. Compare the sha256 of the file against the digest that was pinned.
2. Run `self-test`.

The order is what avoids a circle: neither step asks the tool to vouch for a newer version of
itself.

## Status

The v1 design (see `docs/spec/`) is implemented. See `PROJECT.md` for commands and layout.
