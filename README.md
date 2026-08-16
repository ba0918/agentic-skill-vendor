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
deno run --allow-read --allow-write src/cli.ts <command> [--root <path>]
```

| Command | What it does |
|---|---|
| `gen` | Writes the accepted contracts into every skill that declares them |
| `verify` | Checks the tree against the lock |
| `accept <contract-id>...` | Adopts the current text of the named contracts |
| `lint-selfcontain` | Checks that no skill points outside its own directory |
| `self-test` | Checks the tool against the vectors embedded in it |

`--root` names the tree to work on and defaults to the current directory. The exit code is
`0` when there is nothing to report, `1` when violations were found (one per line on standard
output), and `2` for a configuration or usage error (described on standard error).

A run that stops at exit `2` before the writing phase has written nothing. Once writing has
begun, a failure leaves the tree part way through — copies written, others not — and says so
on standard error. That state is not silent: it is exactly what `verify` reports, and the
writing order is chosen so that what is left behind is a state `verify` calls a violation
rather than one that looks finished.

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

#### What a conformance digest covers

A contract's conformance tests are digested as a whole tree: each file framed as its
relative path, its byte length and its bytes, in path order, hashed as raw bytes and never
canonicalized — a line ending is part of what a conformance test pins.

Which files are in that tree is decided by the `.gitignore` rules of the tree being worked
on, read from `--root` down to the conformance directory and inside it, nested rules and
negations included. A file the repository ignores is one a fresh checkout will not have, so
digesting it would report a mismatch against a tree nobody changed. Editing a `.gitignore`
can therefore change a conformance digest, and `verify` will report that as a mismatch until
it is accepted.

Only the rules are read, never git's index. A file that is ignored but committed anyway
(`git add -f`) is left out of the digest even though a checkout carries it, so changes to it
are not detected. Keep conformance fixtures outside the ignore rules.

A conformance directory left with no files after the exclusion counts as no directory at
all. Git cannot store an empty directory, so any other reading would report a false mismatch
on a fresh checkout.

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

#### What is accepted, and what is refused

The frontmatter is read as YAML, and the declaration is then judged against a schema. Any
YAML spelling of "a list of ids under `metadata.contracts`" is accepted — the block form
above, a flow list (`contracts: [verdict-format, changelog-entry]`), a flow mapping, entries
at the same indent as the `contracts` key, quoted ids, comments anywhere.

A skill declares nothing when the document says so: no frontmatter, no `metadata` key, or a
`metadata` mapping carrying no `contracts` key. Everything else stops the run with exit `2`,
because reading a declaration the tool cannot make sense of as an absent one would silently
unpin a skill that believes it is pinned.

The frontmatter has to open on the first line. A document whose first line is blank, or
anything else, has no frontmatter and declares nothing — a `---` further down is a horizontal
rule, and the block under it is body text. Refused, then:

| Refused | Why |
|---|---|
| Frontmatter YAML cannot parse — a duplicate key, ragged indentation, an unterminated block | The declaration cannot be read at all |
| An opening `---` that is not exactly `---` — a trailing space, a tab, a lone carriage return | Read as "this document has no frontmatter" it would drop the whole block, and trailing whitespace is invisible in an editor |
| A tab in the indentation, anywhere in the frontmatter | YAML forbids it, and parsers that tolerate it re-read the indented key as a sibling — which drops the declaration. The rule is deliberately blunt: a tab-indented line inside a block scalar, where YAML would allow it, is refused too |
| `metadata` that is not a mapping | Same: there is no reading under which its contracts are visible |
| `contracts` that is not a list, or an empty one | The key was written, so something was meant by it |
| An entry that is not text — a number, an empty entry, a mapping | An id is a name; anything else is a different intent |
| An entry carrying a digest (`- id: x` / `digest: …`) | The pin belongs to the lock. Written here, every contract update would show up in the diff of every skill that reads it |
| An id that is unusable as a path component, or named twice | It becomes a file name, and a duplicate hides which one was meant |

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
