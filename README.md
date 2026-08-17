# agentic-skill-vendor

Vendors shared reference documents into the skills of a skill repository. Each skill carries
its own copy of the documents it depends on, every copy is provably byte-identical to its
canonical source, and every change to what a skill carries lands in one reviewable diff —
nothing reaches a skill silently.

Compatibility judgment is explicitly out of scope: a digest can prove a copy matches its
source, not that a new version still suits the skills depending on it. That judgment belongs
to the consuming repository's own regression machinery.

## Install

Add it as a dev dependency of the consuming repository. The install links the
`agentic-skill-vendor` command into `node_modules/.bin`, and the lockfile pins the version:

```
bun add --dev @ba0918/agentic-skill-vendor
bunx agentic-skill-vendor <command> [--root <path>]
```

Any npm-compatible package manager works the same way (`npm install --save-dev` and `npx`,
pnpm, yarn). It can also run with nothing installed, through a one-shot runner — pin the
version in the invocation then, since a bare name resolves the newest release each time:

```
bunx @ba0918/agentic-skill-vendor@<version> <command> [--root <path>]
deno run --allow-read --allow-write npm:@ba0918/agentic-skill-vendor@<version> <command> [--root <path>]
```

The tool runs on Node (>= 20), Bun and Deno from the same source, and reaches nothing but
the file system: no network, no environment, no subprocess. Under Deno, the read-only
commands (`verify`, `lint-selfcontain`, `self-test`) run on `--allow-read` alone.

## Usage

A repository lays out canonical documents ("contracts") and skills like this:

```
contracts/<id>.md                         the canonical text of a contract
contracts/<id>/conformance/**             its conformance tests, if any
skills/<name>/SKILL.md                    a skill, declaring what it depends on
skills/<name>/references/vendor/<id>.md   the copy this tool writes into that skill
vendor-manifest.json                      the lock: the digest recorded for each contract
```

A skill declares its dependencies by id — and only by id — in its `SKILL.md` frontmatter:

```yaml
metadata:
  contracts:
    - changelog-entry
```

The cycle is then:

| Command | What it does |
|---|---|
| `gen` | Writes each contract's current text into every skill that declares it, and rewrites the lock to match |
| `verify` | Checks the whole tree against the lock; exit `1` on any violation |
| `lint-selfcontain` | Checks that no skill points outside its own directory |
| `self-test` | Smoke-checks the tool against vectors embedded in it |

Editing a contract is one act: change `contracts/<id>.md` and run `gen`. The canonical text is
the authority and the lock is the snapshot of it, the relation `package.json` has to a
lockfile — there is no separate approval command, because the text, the lock and the copies
are reviewed together in the pull request they land in. `gen` reports every digest it recorded
a new value for as `adopted: <id> <old digest> -> <new digest>` (a first recording names one
digest only), which is the line to read in a review and the value a consuming repository's
regression machinery matches its own evidence against. A contract's conformance tests get a
line of their own, `adopted: <id> conformance <old> -> <new>`, because the two move
independently; losing the tests is reported as `retired: <id> conformance <old>`, since a value
left the lock and nothing was taken up in its place.

Until `gen` runs, `verify` reports the edit as `stale-lock`; an edited vendored copy, a
missing or extra file, and a stale manifest fail the same run.

Withdrawing a contract — removing it from the skills' declarations and deleting its canonical
text — is the same act at the other end: the next `gen` retires its resolution from the lock
and reports it as `retired: <id>`, so the removal never happens silently.

`--root` names the tree to work on and defaults to the current directory. Exit codes: `0`
nothing to report, `1` violations (one per line on standard output), `2` a refusal or an
internal error (standard error). A run that fails part-way never leaves a tree that looks
finished: whatever it leaves behind is a state `verify` reports as a violation.

### Where to run `verify`

- CI runs `verify` and fails the build on a non-zero exit. CI never runs `gen` — its job is
  detecting a tree that disagrees with its lock, not resolving the disagreement.
- A pre-commit hook running `verify` is an optional tightening. It reads the tree and digests
  the copies, nothing more, so it is cheap enough to run on every commit.

The vendored copies also carry a `DO NOT EDIT` header naming the generating tool, so an
editor who finds a copy learns the canonical text lives elsewhere before an edit lands in the
wrong file; `verify` catches whatever lands anyway.

## Reference

Everything in this section is external compatibility: none of it changes without a version
change.

**A vendored copy's bytes** — a fixed four-line header, then the canonical body:

```
<!-- DO NOT EDIT. Generated by agentic-skill-vendor. -->
<!-- contract: <id> -->
<!-- source-digest: sha256:<64 lowercase hex digits> -->

```

No source path and no time of generation appear anywhere in the file, so two runs over
unchanged input produce the same bytes.

**A conformance digest** — the contract's conformance tree hashed as one sequence, each file
framed as `<relative posix path> NUL <byte length in decimal> NUL <bytes>`, in path order,
raw bytes, never canonicalized. Files excluded by the tree's own `.gitignore` rules are left
out — the rules are read, never git's index — so editing a `.gitignore` can change a
conformance digest, and `verify` reports that until `gen` records the new value.

**Declarations** — frontmatter is read as YAML and judged against a schema. Any YAML spelling
of "a list of ids under `metadata.contracts`" is accepted. A declaration the tool cannot make
sense of stops the run with exit `2` rather than being read as "this skill declares nothing":
unparseable YAML, a malformed opening `---`, a `contracts` value that is not a non-empty list,
an entry that is not text, an id unusable as a path component, or a digest written beside an
id — pins live in the lock, never in a skill.

**Guarded tree access** — a symlink anywhere in the tree is refused; a path holding a
different kind of file system entity than expected stops the run instead of reading as
absent; writes are atomic; identity is verified byte for byte.

**Violation kinds** — every reported line opens with a stable kind prefix: `closure` from
`gen` and `verify` alike (a skill declares a contract whose canonical text is not there, the
one state `gen` refuses to write over); `unresolved`, `stale-lock`, `drift`, `extra`,
`manifest` and `conformance-mismatch` from `verify`; `parent-escape`, `absolute-path` and
`symlink-escape` from `lint-selfcontain`; `self-test` from `self-test`. A successful `gen`
reports in the same shape: `adopted` for each digest it recorded a new value for, `retired` for
a resolution it dropped and for a conformance digest it dropped with the tests behind it.

## Development

The development toolchain is Bun, with Biome for lint and format; `PROJECT.md` records the
commands and layout, and `docs/spec/repository-design.md` (Japanese) records the design
decisions. The source is written against Node-compatible builtins and web standard APIs
only — no runtime's own API — which is what keeps Node, Bun and Deno equally supported.

## License

MIT
