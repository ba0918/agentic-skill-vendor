# agentic-skill-vendor

Vendors shared reference documents into the skills of a skill repository. Each skill carries
its own copy of the documents it depends on, every copy is provably byte-identical to its
canonical source, and every change to what a skill carries lands in one reviewable diff —
nothing reaches a skill silently. A canonical document may live in this repository or in
another one on GitHub; either way each skill ends up with the same byte-identical copy.

Compatibility judgment is explicitly out of scope: a digest can prove a copy matches its
source, not that a new version still suits the skills depending on it. That judgment belongs
to the consuming repository's own regression machinery.

## Install

Add it as a dev dependency of the consuming repository. The install links the
`agentic-skill-vendor` command into `node_modules/.bin`, and the lockfile pins the version:

```
bun add --dev @ba0918-dev/agentic-skill-vendor
bunx agentic-skill-vendor <command> [--root <path>]
```

Any npm-compatible package manager works the same way (`npm install --save-dev` and `npx`,
pnpm, yarn). It can also run with nothing installed, through a one-shot runner — pin the
version in the invocation then, since a bare name resolves the newest release each time:

```
bunx @ba0918-dev/agentic-skill-vendor@<version> <command> [--root <path>]
deno run --allow-read --allow-write npm:@ba0918-dev/agentic-skill-vendor@<version> <command> [--root <path>]
```

The tool runs on Node (>= 20), Bun and Deno from the same source. It reads no environment
variable and starts no subprocess, ever. Three commands reach the network — `add`, `update`
and `fetch`, over HTTPS to `api.github.com` and `raw.githubusercontent.com` and nowhere else
— and the rest touch the file system alone. Under Deno the read-only commands (`verify`,
`lint-selfcontain`, `self-test`) run on `--allow-read`, `gen` needs `--allow-write` too, and
only the three fetching commands need `--allow-net`.

## Usage

A repository lays out canonical documents ("contracts") and skills like this:

```
contracts/<id>.md                         the canonical text of a contract
contracts/<id>/conformance/**             its conformance tests, if any
skills/<name>/SKILL.md                    a skill, declaring what it depends on
skills/<name>/references/vendor/<id>.md   the copy this tool writes into that skill
vendor-manifest.yaml                      the table of origins: where each contract comes from
vendor-lock.json                          the lock: the digest recorded for each contract
.agentic-skill-vendor/                    the cache of fetched text — never committed
```

The last three are the tool's own files. `vendor-manifest.yaml` and `.agentic-skill-vendor/`
appear only once a repository takes a contract from somewhere else; a repository using
nothing but its own contracts has the lock and the copies, as it always did.

A skill declares its dependencies by id — and only by id — in its `SKILL.md` frontmatter:

```yaml
metadata:
  contracts:
    - changelog-entry
```

The cycle is then:

| Command | What it does | Network |
|---|---|---|
| `add <owner/repo> [name]` | Registers another repository as a source, records the branch it hands out, resolves that branch to a commit, and takes up every declared contract it holds | yes |
| `update` | Moves every registered source's pin to what its ref names now, and fetches what the new pin holds | yes |
| `fetch` | Fills the cache with exactly what the lock already pins — the command a clean checkout runs | yes |
| `gen` | Writes each contract's current text into every skill that declares it, and rewrites the lock to match | no |
| `verify` | Checks the whole tree against the lock; exit `1` on any violation | no |
| `lint-selfcontain` | Checks that no skill points outside its own directory | no |
| `self-test` | Smoke-checks the tool against vectors embedded in it | no |

Editing a contract is one act: change `contracts/<id>.md` and run `gen`. The canonical text is
the authority and the lock is the snapshot of it, the relation `package.json` has to a
lockfile — there is no separate approval command, because the text, the lock and the copies
are reviewed together in the pull request they land in. `gen` reports every digest it recorded
a new value for as `adopted: <id> <old digest> -> <new digest>` (a first recording names one
digest only, annotated `(initial adoption)`), which is the line to read in a review and the
value a consuming repository's regression machinery matches its own evidence against. A
contract's conformance tests get a line of their own, `adopted: <id> conformance <old> -> <new>`
(first recordings take the same one-value form), because the two move
independently; losing the tests is reported as `retired: <id> conformance <old>`, since a value
left the lock and nothing was taken up in its place.

Until `gen` runs, `verify` reports the edit as `stale-lock`; an edited vendored copy, a
missing or extra file, and a lock file that no longer matches what the tree renders to fail
the same run.

Withdrawing a contract — removing it from the skills' declarations and deleting its canonical
text — is the same act at the other end: the next `gen` retires its resolution from the lock
and reports it as `retired: <id>`, so the removal never happens silently.

### Taking a contract from another repository

A shared document belongs in the repository most responsible for it, and every other
repository fetches it rather than keeping a copy of its own. Register the source once:

```
bunx agentic-skill-vendor add ba0918/agentic-workflow workflow
```

That writes `vendor-manifest.yaml` — the table saying where each contract comes from —
records the branch the repository hands out as an explicit value, resolves it to a commit in
`vendor-lock.json`, and fetches the text of every contract your skills already declare and
that repository holds at `contracts/<id>.md`. The optional second argument names the source;
without it the repository's own name is used. Then run `gen` as usual.

The table is written by the tool. Two lines are yours to write:

```yaml
contracts:
  writing-style:
    source: local
    path: docs/style/writing-style.md   # a canonical text outside contracts/
  tdd-contract:
    source: workflow                    # which source, when two of them hold it
```

Everything else — a `source: local` line for each contract of your own, a line for each
contract exactly one source holds, and the removal of a line no skill declares any more — is
derived and reported: `mapped: <id> <- <source>` when a line is written, `unmapped: <id>`
when one is taken out, `resolved: <source> <old commit> -> <new commit>` when a pin moves (a
first resolution names one commit and is annotated `(initial resolution)`).

Fetched text is cached under `.agentic-skill-vendor/` and is never committed — add it to
`.gitignore`, anchored to the repository root, or the fetching commands will warn on every
run:

```
/.agentic-skill-vendor/
```

Deleting the whole directory costs one `fetch`. The lock records the commit each source is
pinned at, and `fetch` judges every downloaded file against the object id that commit's own
listing gives it — the lock takes no part in the check, which is what lets the cache be rebuilt
from whatever state the tree is in. A revision's directory is placed in a single move once every
file of it has arrived, so a directory standing at its place means that revision was fetched
whole and a fetch stopped part way leaves no revision behind at all. Three answers stop a
fetching run with nothing written: a file the run was about to take — the canonical text at its
mapped path, or one of the conformance tests beside it — listed as anything but an ordinary file
(a symlink, a submodule), a redirect, and a value that would not read back as itself — the
default branch `add` records is checked exactly as a ref read from the table is. The directory
those tests sit in is judged too, though nothing is ever taken from it: a link or a submodule
standing there is listed with nothing beneath it, so tests the source does keep would be pinned
as absent — while an ordinary file there is left alone, since nothing can sit under a path a blob
occupies and a contract carrying no tests is then a fact. Everything else a source holds is
ignored whatever its mode, and never fetched: what the refusal keeps out is a file being dropped
from a fetch and read back afterwards as one upstream does not hold, which a file no run opens
cannot cause.

The repository each source is pinned to is the one `vendor-manifest.yaml` registers. Edit that
line and the tree disagrees with itself until `update` runs: `verify` reports the source as
`source-mismatch`, and `gen` and `fetch` stop for it rather than act on a pin the table
contradicts. `update` is the way back — it reads the repository and the ref from the table
alone.

`gen` and `verify` never fetch: `gen` stops and asks for a `fetch` when the cache is missing
rather than resolving a ref of its own, since that would take up whatever the source holds
today with nothing in any diff saying a new version was adopted. Where the lock pins no commit
for the source at all it asks for an `update` instead — a `fetch` reproduces a pin rather than
deciding one, and would only ask for the same update itself.

`--root` names the tree to work on and defaults to the current directory. Exit codes: `0`
nothing to report, `1` violations (one per line on standard output), `2` a refusal or an
internal error (standard error). A run that fails part-way never leaves a tree that looks
finished: whatever it leaves behind is a state `verify` reports as a violation.

### Where to run `verify`

- CI runs `verify` and fails the build on a non-zero exit. CI never runs `gen` — its job is
  detecting a tree that disagrees with its lock, not resolving the disagreement. It needs no
  network and no cache: for a contract fetched from another repository, `verify` compares the
  copies against the lock and the lock against what the tree renders to, and silently leaves
  out the two comparisons that need the canonical text (the text against the lock, and the
  conformance tests against the lock) when the cache is not there. Run `fetch` before
  `verify` where the full comparison is wanted. What is never left out is the lock recording
  nothing at all for a declared contract: that is reported as `unresolved` with a cache or
  without one, so the tree an `add` wrote the mapping for and no `gen` ever finished fails the
  build instead of shipping a skill without the document it declares.
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
`lock`, `source-mismatch` (the lock pins a source to a repository the table of origins does
not register it at) and `conformance-mismatch` from `verify`; `parent-escape`, `absolute-path` and
`symlink-escape` from `lint-selfcontain`; `self-test` from `self-test`. A successful run
reports in the same shape: `adopted` and `retired` from `gen` for each digest it recorded a
new value for or dropped, `mapped` and `unmapped` for each line it wrote into or took out of
the table of origins, and `resolved` from `add` and `update` for each pin they moved.

## Development

The development toolchain is Bun, with Biome for lint and format; `PROJECT.md` records the
commands and layout, and `docs/spec/repository-design.md` (Japanese) records the design
decisions. The source is written against Node-compatible builtins and web standard APIs
only — no runtime's own API — which is what keeps Node, Bun and Deno equally supported.

## License

MIT
