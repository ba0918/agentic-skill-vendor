# agentic-skill-vendor

Keeps a shared document in one place and gives every skill that needs it its own copy.

In this README, a contract is either a shared document or a set of raw files and directories
that skills need to carry identically.

A document contract's generated copy carries a fixed header followed by its canonical body. A
raw-byte contract copies each payload file byte for byte; a generated directory marker is a
separate file. Every change to what a skill carries lands in one reviewable diff — nothing
reaches a skill silently. The source may live in this repository or in another one on GitHub.

Compatibility judgment is out of scope. A digest proves a copy matches its source, not that a
new version still suits the skills depending on it — that judgment belongs to the consuming
repository's own regression machinery.

## Choose a starting point

- Keep local documents in sync: [Quickstart](#quickstart)
- Distribute raw files or directories: [Distributing files and directories as they are](#distributing-files-and-directories-as-they-are)
- Take a contract from another repository: [Taking a contract from another repository](#taking-a-contract-from-another-repository)
- Check committed output in CI: [Running it in CI](#running-it-in-ci)

Whichever path you take, [review the generated changes](#review-generated-changes) after `gen`.

## Review generated changes

After `gen`, review and commit the generated copies and `vendor-lock.json` with the canonical
source change. Also review and commit `vendor-manifest.yaml` when you add or change a raw
mapping or a remote-source row.

## Quickstart

Add it as a dev dependency of the repository holding your skills:

```
bun add --dev @ba0918-dev/agentic-skill-vendor
```

Write the document once, under `contracts/`:

```
contracts/changelog-entry.md
```

Have each skill that needs it name it — by id, and only by id — in its `SKILL.md`
frontmatter:

```yaml
metadata:
  contracts:
    - changelog-entry
```

Then distribute it, and check the result:

```
bunx agentic-skill-vendor gen
bunx agentic-skill-vendor verify
```

`gen` writes `skills/<name>/references/vendor/changelog-entry.md` into every skill that
declared it, and records the digest it distributed in `vendor-lock.json`. `verify` exits `1`
if anything in the tree no longer agrees with that lock — put it in CI. Editing the document
is the same two commands again.

That is the whole cycle for documents this repository owns. Taking one from another
repository adds three commands, [below](#taking-a-contract-from-another-repository).

## Install and runtimes

Any npm-compatible package manager works (`npm install --save-dev` and `npx`, pnpm, yarn).
It also runs with nothing installed, through a one-shot runner — pin the version there, since
a bare name resolves the newest release each time:

```
bunx @ba0918-dev/agentic-skill-vendor@<version> <command> [--root <path>]
# A read-only command
deno run --allow-read=. npm:@ba0918-dev/agentic-skill-vendor@<version> verify

# A local write, with no network access
deno run --allow-read=. --allow-write=. npm:@ba0918-dev/agentic-skill-vendor@<version> gen

# Commands that fetch from GitHub
deno run --allow-read=. --allow-write=. --allow-net=api.github.com,raw.githubusercontent.com npm:@ba0918-dev/agentic-skill-vendor@<version> add <owner/repo>
deno run --allow-read=. --allow-write=. --allow-net=api.github.com,raw.githubusercontent.com npm:@ba0918-dev/agentic-skill-vendor@<version> update
deno run --allow-read=. --allow-write=. --allow-net=api.github.com,raw.githubusercontent.com npm:@ba0918-dev/agentic-skill-vendor@<version> fetch
```

These examples limit file access to the current root. When using `--root <path>`, replace `.`
in the read and write permissions with that path.

The same source runs on Node (>= 20.10), Bun and Deno. It reads no environment variable and
starts no subprocess, ever. Three commands reach the network — `add`, `update` and `fetch`,
over HTTPS to `api.github.com` and `raw.githubusercontent.com` and nowhere else — and the rest
touch the file system alone. Under Deno the read-only commands need only read access to the
root, `gen` adds write access to it, and only the three fetching commands need access to the
two GitHub hosts.

## The commands

| Command | What it does | Network |
|---|---|---|
| `gen` | Writes each contract's current text into every skill that declares it, and rewrites the lock to match | no |
| `verify` | Checks the whole tree against the lock; exit `1` on any violation | no |
| `lint-selfcontain` | Checks that no skill points outside its own directory | no |
| `self-test` | Smoke-checks the tool against vectors embedded in it | no |
| `add <owner/repo> [name]` | Registers another repository as a source and takes up every declared contract it holds | yes |
| `update` | Moves every pin to what its ref names now, and fetches what the new pin holds | yes |
| `fetch` | Fills the cache with exactly what the lock already pins — what a clean checkout runs | yes |

`--root` names the tree to work on and defaults to the current directory. Exit codes: `0`
nothing to report, `1` violations (one per line on standard output), `2` a refusal or an
internal error (standard error).

## The tree

```
contracts/<id>.md                         the canonical text of a contract
contracts/<id>/conformance/**             its conformance tests, if any
skills/<name>/SKILL.md                    a skill, declaring what it depends on
skills/<name>/references/vendor/<id>.md   the copy this tool writes into that skill
skills/<name>/<dest>                      a raw-byte contract's copy, where the table says
vendor-manifest.yaml                      origins and raw-byte source-to-destination mappings
vendor-lock.json                          the lock: the digest recorded for each contract
.agentic-skill-vendor/                    the cache of fetched text — never committed
```

The last three are the tool's own files. `vendor-manifest.yaml` is needed when a contract comes
from another repository or when raw files or directories are distributed, because it records
their origins and source-to-destination mappings. It is not needed when every contract is a
local document at its standard `contracts/<id>.md` path. `.agentic-skill-vendor/` appears only
after a repository fetches a contract from another repository; a repository using only local
documents has the lock and generated copies, as it always did.

## Changing a contract

The canonical text is the authority and the lock is the snapshot of it — the relation
`package.json` has to a lockfile. There is no separate approval command, because the text, the
lock and the copies are reviewed together in the pull request they land in.

`gen` reports every digest it recorded a new value for:

```
adopted: <id> <old digest> -> <new digest>
adopted: <id> conformance <old> -> <new>
retired: <id> conformance <old>
```

A first recording names one digest only, annotated `(initial adoption)`. A contract's text and
its conformance tests move independently, so they get a line each; losing the tests is a
retirement, since a value left the lock and nothing was taken up in its place. These lines are
what to read in a review, and what a consuming repository's regression machinery matches its
own evidence against.

Until `gen` runs, `verify` reports the edit as `stale-lock`. An edited vendored copy, a missing
or extra file, and a lock that no longer matches what the tree renders to fail the same run.

Withdrawing a contract — removing it from the skills' declarations and deleting its canonical
text — is the same act at the other end: the next `gen` retires its resolution and reports
`retired: <id>`, so the removal never happens silently.

## Distributing files and directories as they are

A contract need not be a document. Scripts several skills share — a runtime every workflow
skill drives, a helper a few of them call — are distributed as raw bytes, from one canonical
place to a position of your choosing inside each skill, by a `files` line in the table of
origins in `vendor-manifest.yaml`:

```yaml
ignore:
  - "**/*.test.ts"                         # every raw directory source

contracts:
  workflow-runtime:
    source: local
    ignore:
      - "fixtures/"                        # this contract only
    files:
      tools/workflow-runtime/: scripts/_runtime/    # a directory, whole
  check-script:
    source: local
    files:
      tools/scripts/check.sh: scripts/check.sh      # one file
```

The left side is where the canonical files are (in this repository, or in a registered source);
the right side is where each copy lands, relative to the skill. A trailing slash on both sides
names a directory, on neither a file. The bytes are copied exactly — no header, no line-ending
normalization — and a directory copy carries one extra file, `.vendored`, saying where it came
from. Skills declare the contract by id, as they declare every contract:

```yaml
metadata:
  contracts:
    - workflow-runtime
```

Both `ignore` fields are optional arrays of strings. They use `.gitignore` pattern syntax,
including `*`, `**`, anchored `/`, comments, and escapes. An unescaped leading `!` is refused:
contract-specific rules may add exclusions but cannot undo a shared one. Each directory mapping
is matched independently against POSIX paths relative to its own source directory, so `/build.ts`
means the `build.ts` immediately inside every mapped directory. These rules do not affect an
explicit file source or a document contract.

Exclusion changes what is distributed, digested, and recorded, not what is fetched or safety
checked. A remote directory source is fetched and verified in full and then filtered while its
cache is read. If that cache is absent, `verify` still compares the lock with the existing copies
but cannot evaluate an `ignore` change; run `fetch` and then `verify` for the full comparison.
Links, reserved files, and other unsafe source entries are inspected before filtering.

When a new rule excludes a file that was distributed earlier, `verify` reports the old copy as
`drift` when the canonical source is available, and the next `gen` removes it by replacing the
directory destination. If filtering leaves a mapped directory with no distributable files,
`gen` and `verify` stop with a configuration error before changing the lock or existing copies.

`files` lines are yours to write, always: there is no conventional position for a set of files,
so nothing derives them, and `gen` never takes one out. `add` and `update` report a declared id
they find at no conventional position as `unlocated: <id>`, which is the cue to write one.

The copies land wherever you pointed them, so the lock records what was written where —
`placements`, skill by skill and dest by dest — and `gen` reads that record before it touches a
path:

- A dest that holds nothing is written. A dest the lock remembers, still holding what was
  written there, is replaced. A dest that already holds exactly what `gen` would write — a hand
  copy from before, or a tree whose lock was lost — is taken over and reported as
  `claimed: skills/<skill>/<dest> (<id>)`. Anything else standing at a dest stops the run: the
  tool never replaces what it cannot show it wrote.
- A dest the lock remembers that no skill declares any more — the skill withdrew, the table
  moved the dest, the skill directory went — is cleared and reported as
  `cleared: skills/<skill>/<dest> (<id>)`, or `(<id>; already absent)` where nothing was left
  to clear. Only a dest still holding what the lock recorded is cleared; one you have edited
  since is refused.
- Inside a directory dest, files the repository's `.gitignore` rules exclude — `__pycache__/`
  after a run, an editor's leavings — are neither checked nor protected: they go with the next
  replacement. A directory dest is the tool's; keep local files out of it. A dest, or a file
  being placed in one, that those rules would exclude outright is refused instead, since a copy
  `verify` cannot see is not one `gen` may write.

`verify` compares each recorded dest with the digest recorded for it, and the record itself
with what the declarations and the table say it should be (`placement`), and needs neither the
canonical files nor a network to do so. Moving a dest in the table changes no contract digest
and produces no `adopted` line; moving the canonical files themselves does, since where the
files sit is part of what a raw-byte contract is.

A contract cannot change kind in place: a row rewritten from `files` to a document, or back, is
refused while the lock remembers the other kind. Withdraw it from every skill, run `gen`, take
the row out, run `gen` again, then write the new row. Executable bits are not copied and not
checked; invoke a distributed script through its interpreter.

## Taking a contract from another repository

A shared document belongs in the repository most responsible for it, and every other
repository fetches it rather than keeping a copy of its own. Register the source once, then
distribute as usual:

```
bunx agentic-skill-vendor add ba0918/agentic-workflow workflow
bunx agentic-skill-vendor gen
```

`add` writes `vendor-manifest.yaml`, records the branch that repository hands out as an
explicit value, resolves it to a commit in `vendor-lock.json`, and fetches every contract your
skills already declare and that repository holds at `contracts/<id>.md`. The optional second
argument names the source; without it the repository's own name is used.

Keep the cache out of git — anchored to the repository root, or the fetching commands warn on
every run:

```
/.agentic-skill-vendor/
```

Deleting the whole directory costs one `fetch`.

From then on, `update` moves every pin to what its ref names now, and `fetch` restores the
cache from what the lock already pins. `gen` and `verify` never fetch. `gen` stops and asks
for a `fetch` when the cache is missing rather than resolving a ref of its own, since that
would take up whatever the source holds today with nothing in any diff saying a new version
was adopted; where the lock pins no commit at all it asks for an `update` instead, since a
`fetch` reproduces a pin rather than deciding one.

### The table of origins

`vendor-manifest.yaml` is written by the tool. Two lines are yours to write:

```yaml
contracts:
  writing-style:
    source: local
    path: docs/style/writing-style.md   # a canonical text outside contracts/
  tdd-contract:
    source: workflow                    # which source, when two of them hold it
```

Everything else is derived and reported: a `source: local` line for each contract of your own,
a line for each contract exactly one source holds, and the removal of a line no skill declares
any more — `mapped: <id> <- <source>` when a line is written, `unmapped: <id>` when one is
taken out, `resolved: <source> <old commit> -> <new commit>` when a pin moves (a first
resolution names one commit, annotated `(initial resolution)`).

The repository each source is pinned to is the one this table registers. Edit that line and the
tree disagrees with itself until `update` runs: `verify` reports `source-mismatch`, and `gen`
and `fetch` stop for that source rather than act on a pin the table contradicts. `update` is
the way back — it reads the repository and the ref from the table alone.

## Running it in CI

CI runs `verify` and fails the build on a non-zero exit. CI never runs `gen` — its job is
detecting a tree that disagrees with its lock, not resolving the disagreement.

For a repository that installs this package with Bun, the smallest GitHub Actions workflow is:

```yaml
name: Verify vendored contracts

on: [pull_request]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.x"
      - run: bun install --frozen-lockfile
      - run: bunx agentic-skill-vendor verify
```

After dependencies are installed, the `verify` step itself needs neither network access nor the
`.agentic-skill-vendor/` cache. The install step downloads packages from the registry and does
need network access. For a contract fetched from another repository, `verify` compares the
copies against the lock and the lock against what the tree renders to, and silently leaves out
the two comparisons that need the canonical text (the text against the lock, and the conformance
tests against the lock) when the cache is not there. Run `fetch` before `verify` where the full
comparison is wanted.

What is never left out is the lock recording nothing at all for a declared contract: that is
reported as `unresolved` with a cache or without one, so the tree an `add` wrote the mapping
for and no `gen` ever finished fails the build instead of shipping a skill without the document
it declares.

A pre-commit hook running `verify` is an optional tightening: it reads the tree and digests the
copies, nothing more.

The vendored copies also carry a `DO NOT EDIT` header naming the generating tool, so an editor
who finds a copy learns the canonical text lives elsewhere before an edit lands in the wrong
file; `verify` catches whatever lands anyway.

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

**A raw-byte contract's digests** — the same framing as a conformance digest (below), twice.
The contract's own digest names each file by its canonical path (the `files` key, expanded for
a directory), so it says what the canonical side is and nothing about where copies land. Each
placement's digest names the files relative to the dest — a file dest by its own name — and
leaves out the `.vendored` marker, so a copy can be judged from the copy alone. The marker
itself is the four-line header above as a file of its own, carrying the contract's digest.

**The lock** — `dependencies` (skill → ids), `resolutions` (id → digest, with `conformance`
where tests exist and `"kind": "raw"` for a raw-byte contract), `sources` (pins, only where a
source is registered) and `placements` (skill → dest → `contract`, `src`, `digest`, only where
raw bytes are distributed). `placements` is written by `gen` alone and carried unchanged by
every other command; directory dests and srcs keep their trailing slash.

**A conformance digest** — the contract's conformance tree hashed as one sequence, each file
framed as `<relative posix path> NUL <byte length in decimal> NUL <bytes>`, in path order, raw
bytes, never canonicalized. Files excluded by the tree's own `.gitignore` rules are left out —
the rules are read, never git's index — so editing a `.gitignore` can change a conformance
digest, and `verify` reports that until `gen` records the new value.

**Declarations** — frontmatter is read as YAML and judged against a schema. Any YAML spelling
of "a list of ids under `metadata.contracts`" is accepted. A declaration the tool cannot make
sense of stops the run with exit `2` rather than being read as "this skill declares nothing":
unparseable YAML, a malformed opening `---`, a `contracts` value that is not a non-empty list,
an entry that is not text, an id unusable as a path component, or a digest written beside an id
— pins live in the lock, never in a skill.

**Guarded tree access** — a symlink anywhere in the tree is refused; a path holding a different
kind of file system entity than expected stops the run instead of reading as absent; writes are
atomic; identity is verified byte for byte. A run that fails part-way never leaves a tree that
looks finished: whatever it leaves behind is a state `verify` reports as a violation.

**Violation kinds** — every reported line opens with a stable kind prefix:

| Kind | From | What it means |
|---|---|---|
| `closure` | `gen`, `verify` | a skill declares a contract whose canonical text is not there — the one state `gen` refuses to write over |
| `unresolved` | `verify` | the lock records nothing for a declared contract |
| `stale-lock` | `verify` | the lock records a digest the canonical text no longer has |
| `drift` | `verify` | a vendored copy, a raw-byte dest or its `.vendored` marker is missing, or is not what the lock pins |
| `extra` | `verify` | a file under a skill's vendor directory answers to no declaration |
| `lock` | `verify` | the lock file differs from what the tree renders to |
| `placement` | `verify` | the lock's record of what was placed where disagrees with what the declarations and the table say |
| `source-mismatch` | `verify` | the lock pins a source to a repository the table of origins does not register it at |
| `conformance-mismatch` | `verify` | a conformance tree differs from the digest the lock records |
| `parent-escape` | `lint-selfcontain` | something inside a skill points above its own directory |
| `absolute-path` | `lint-selfcontain` | something inside a skill names an absolute path |
| `symlink-escape` | `lint-selfcontain` | a symlink inside a skill resolves outside it |
| `self-test` | `self-test` | the tool disagrees with a vector embedded in it |

A successful run reports in the same shape, and on the same stability footing: `adopted`,
`retired`, `claimed` and `cleared` from `gen`, `mapped` and `unmapped` for the table of origins,
and `resolved` and `unlocated` from `add` and `update`.

## Design notes

Why the fetching half is shaped the way it is. None of this is needed to use the tool.

**A download is judged against its commit, never against the lock.** The lock records the
commit each source is pinned at, and `fetch` judges every downloaded file against the object id
that commit's own listing gives it. A commit is immutable and says what each of its files
hashes to, so "the cache holds what this commit holds" is established without the lock — which
is what lets the cache be rebuilt from whatever state the tree is in.

**A revision arrives whole or not at all.** Its directory is placed in a single move once every
file has arrived, so a directory standing at its place means that revision was fetched whole,
and a run stopped part way leaves no revision behind for a later command to read as a fetch
that finished.

**Three answers stop a fetching run with nothing written.** A file the run was about to take —
the canonical text at its mapped path, or a conformance test beside it — listed as anything but
an ordinary file (a symlink, a submodule) or under a path that does not stay inside the
repository listing it (an empty segment, a `.` or `..` step, a backslash); a redirect, since
the fixed pair of hosts would otherwise hold for the first request of a run only; and a value
that would not read back as itself, the default branch `add` records included.

**The conformance directory is judged although nothing is taken from it.** A link or a submodule
standing there is listed with nothing beneath it, so tests the source does keep would be pinned
as absent. An ordinary file there is left alone: nothing can sit under a path a blob occupies,
so a contract carrying no tests is then a fact rather than something the fetch dropped.

**Nothing else in a source is judged.** Everything else is ignored whatever its mode and
whatever its name, and never fetched — a file no run opens cannot be dropped from a fetch and
read back as one upstream does not hold. Judged over the whole listing instead, one file a
repository on POSIX legitimately tracks (`tests/fixtures/windows\path.txt` among them) put
every contract that source holds out of reach, over a name no contract had anything to do with.

## Development

The development toolchain is Bun, with Biome for lint and format; `PROJECT.md` records the
commands and layout, and `docs/spec/` (Japanese) records the design decisions. The source is
written against Node-compatible builtins and web standard APIs only — no runtime's own API —
which is what keeps Node, Bun and Deno equally supported.

## License

MIT
