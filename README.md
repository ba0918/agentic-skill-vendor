# agentic-skill-vendor

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

The tool is not locked to any particular repository. It is written in TypeScript against
Node-compatible builtins and web standard APIs only — no runtime's own API — so the same
source runs on Node, Bun and Deno, and this side's choice of runtime never becomes a
requirement on the consuming side.

## Using it

No version has been released yet. The forms below describe how the package is run once it
is published; until then, run it from a checkout with `bun run src/cli.ts`.

It is distributed through npm and run through whichever runner the consuming repository
already has. Nothing has to be copied into that repository. These are the recommended
forms — the tool cannot enforce how it is invoked, and every one of them reaches the same
CLI:

```
bunx @ba0918/agentic-skill-vendor <command> [--root <path>]
npx @ba0918/agentic-skill-vendor <command> [--root <path>]
pnpm dlx @ba0918/agentic-skill-vendor <command> [--root <path>]
yarn dlx @ba0918/agentic-skill-vendor <command> [--root <path>]
deno run --allow-read --allow-write npm:@ba0918/agentic-skill-vendor <command> [--root <path>]
```

Pinning the version is the consuming repository's call, and pinning it is what makes a run
repeatable — a runner given a bare name resolves the newest release each time.

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

The tool reaches nothing but the file system on any runtime: no network, no environment,
no subprocess. Run under Deno, that can be held to further: `verify`, `lint-selfcontain` and
`self-test` never write, so they run on `--allow-read` alone, and only `gen` and `accept`
need `--allow-write`. That is an additional restriction Deno makes available, not a
guarantee this tool provides — Node and Bun have no permission sandbox to enforce it.

### Where to run `verify`

`accept` is the only way a change of contract text becomes adopted, but where that boundary
is checked is wiring the consuming repository owns. The recommended shape:

- **CI runs `verify` and fails the build on a non-zero exit.** This is the enforcement
  point: an edit made to a vendored copy, a contract changed without `accept`, and a
  half-written tree all surface here as violations. CI never runs `accept` — its job is
  detecting unapproved drift, not approving it.
- **A pre-commit hook running `verify` is an optional tightening.** It moves the same
  report from the CI round-trip to the moment of committing. `verify` reads the tree and
  digests the copies, nothing more, so it is cheap enough to run on every commit.

Neither replaces the header a vendored copy carries: the header informs an editor before an
edit lands in the wrong file, and `verify` catches whatever lands anyway.

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

#### The bytes a vendored copy carries

A vendored copy is its header followed by the canonical body, with nothing else between
them. The header is exactly four lines — three comments and one blank — and `verify`
compares them byte for byte:

```
<!-- DO NOT EDIT. Generated by agentic-skill-vendor. -->
<!-- contract: <id> -->
<!-- source-digest: sha256:<64 lowercase hex digits> -->

```

The generator name is a fixed string — not a path, and not the tool's version, which is
recorded in the manifest and nowhere else. It does not change from one release to the next.
No source path and no time of generation appear anywhere in the file either, so two runs
over unchanged input produce the same bytes.

#### The bytes a conformance digest is taken over

Each file in the tree contributes its relative posix path, a NUL byte, its byte length in
decimal, a NUL byte, and then its bytes:

```
<relative/posix/path>\0<byte length>\0<bytes>
```

The files are fed in order of their relative path, compared by code unit. Nothing separates
one file's bytes from the next file's path; the length is what says where the bytes end, so
no arrangement of names and contents can be confused with another one. The result is
`sha256:` followed by 64 lowercase hex digits.

Both of these are external compatibility: changing either one changes every digest already
recorded, so neither moves without a version change.

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
at the same indent as the `contracts` key, quoted ids, a `metadata` block assembled through
a merge key (`<<`), comments anywhere. An id has to survive that reading as text: one
written so that YAML resolves it to a number is refused rather than guessed at.

A skill declares nothing when the document says so: no frontmatter, no `metadata` key, or a
`metadata` mapping carrying no `contracts` key. Everything else stops the run with exit `2`,
because reading a declaration the tool cannot make sense of as an absent one would silently
unpin a skill that believes it is pinned.

The frontmatter has to open on the first line. A document that opens with anything else has
no frontmatter and declares nothing — a `---` further down is a horizontal rule, and the text
under it is body. The exception is a document that reaches `---` with only blank lines above
it: a horizontal rule at the very top of a body separates nothing, so the only thing that
shape can plausibly be is frontmatter that lost its position, and it is refused rather than
read as bodyless. Refused, then:

| Refused | Why |
|---|---|
| Frontmatter YAML cannot parse — a duplicate key, ragged indentation, an unterminated block | The declaration cannot be read at all |
| An opening `---` that is not exactly `---` — a trailing space, a tab, a lone carriage return, or any character Unicode marks as showing nothing (a zero-width space, a word joiner, a bidi mark) | Read as "this document has no frontmatter" it would drop the whole block. Every one of these is invisible in an editor, and trimming whitespace removes none of the invisible ones |
| A `---` reached with only blank lines above it | Same drop, from a leading blank line alone. A rule at the top of a body separates nothing, so nothing legitimate is refused |
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

## Status

The v1 design (see `docs/spec/`) is implemented, and no version has been released yet. See
`PROJECT.md` for commands and layout.
