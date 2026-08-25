# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-25

### Added

- **A token for private and rate-limited sources.** `--token-stdin` reads a GitHub token from
  standard input and `add`, `update` and `fetch` send it as an `Authorization: Bearer` header
  to both hosts, which is what a source in a private repository needs and gives authenticated
  requests the allowance GitHub assigns to that credential and account. Standard input rather
  than a file or an environment variable: a pipe leaves no copy of the secret at rest, appears
  in no process listing or shell history, and needs no permission of its own, so the Deno flags
  every command documents are unchanged and nothing here reads the environment. The value is
  judged before it is sent — printable ASCII, no spaces, at most 1024 characters, with exactly
  one trailing LF or CRLF removed — held for one run, written nowhere, and named by no refusal,
  which report a position instead. `gen`, `verify`, `lint-selfcontain` and `self-test` refuse
  the flag: they reach no network, and accepting it would contradict the boundary they state.

- `gen` reports `unused: <id>` for a resolution the lock keeps that no skill declares any
  more — a declaration withdrawn while the canonical text stayed, which is not a retirement
  and until now passed in silence. Reported every run, since it is a standing state; the
  resolution is not removed and the exit code does not change. A canonical text nothing has
  ever declared is not reported, so a repository holding contracts for other repositories to
  fetch stays quiet.

### Changed

- A refused request from a run carrying a token names the token as a likely cause instead of
  the unauthenticated hourly allowance, and does so for `401` and `404` as well as `403` and
  `429`. Handed an `Authorization` header it cannot validate, `raw.githubusercontent.com`
  answers `404` for a file it serves anonymously with `200`, so an expired token makes a
  public source look empty rather than making itself known. An unauthenticated run's
  refusals are unchanged.

### Fixed

- `references/vendor` was written as a separate literal in two modules, one building the
  directory the document copies go into and the other refusing a raw-byte dest that would
  land on them. They share one constant now; drifted apart, a raw contract could have been
  placed over a document copy with neither side seeing a collision.

## [0.4.0] - 2026-08-24

### Added

- Raw directory contracts may define shared and contract-specific `ignore` pattern arrays in
  `vendor-manifest.yaml`. The backward-compatible option uses `.gitignore` syntax to exclude
  files from distribution and digests while preserving full remote fetches and existing
  manifests that omit it.
- Raw-byte dest conflicts are now scoped to each skill: different skills may independently use
  the same dest, while `gen` and `verify` still refuse identical or nested final dests inside one
  skill. `add`, `update`, and `fetch` may read overlapping table rows that they do not place.
- `gen` can migrate overlapping owned dests in one run, including directory-to-children and
  children-to-directory changes. It refuses edited old placements and unknown content, replaces
  one owned outermost artifact through staging, and recovers only from the intact old, absent, or
  exact completed state. The lock schema, report kinds, and commands' external-I/O boundaries do
  not change.

## [0.3.0] - 2026-08-24

### Added

- **Raw-byte contracts.** A `files` line in `vendor-manifest.yaml` maps canonical files and
  directories (in this repository or a registered source) to a dest of your choosing inside
  every skill declaring the contract. The bytes are copied as they are — no header, no
  normalization — and a directory copy carries a `.vendored` marker. The lock gains
  `placements` (what was written where, per skill and dest) and marks such a resolution
  `"kind": "raw"`; `gen` writes a dest only where nothing stands, where the lock remembers
  writing it, or where it already holds exactly what would be written (`claimed`), clears the
  dests no skill declares any more (`cleared`), and refuses the rest. `verify` checks each
  dest against the digest recorded for it and the record against the table (`placement`),
  without the canonical files or a network. `add` and `update` report a declared id found at
  no conventional position as `unlocated`.

## [0.2.0] - 2026-08-18

### Added

- **Contracts from another repository.** A canonical document may now live in another public
  GitHub repository. `add <owner/repo> [name]` registers a source, records the branch it hands
  out, resolves it to a commit and takes up every declared contract it holds; `update` moves
  every pin to what its ref names now; `fetch` restores the cache from what the lock pins.
  Those three are the only commands that reach a network, over HTTPS to `api.github.com` and
  `raw.githubusercontent.com` and nowhere else. `gen`, `verify`, `lint-selfcontain` and
  `self-test` still read and write the tree and nothing else.
- **`vendor-manifest.yaml`**, the table of where each contract comes from. The tool writes it:
  `gen` maps the contracts this repository holds itself, `add` and `update` map the ones
  exactly one registered source holds, and lines no skill declares any more are taken out. Two
  things stay yours to write — which source wins when several hold one contract, and where a
  canonical text sits when it is not at the conventional position. A repository with no source
  registered keeps no table and behaves exactly as before.
- **A cache**, under `.agentic-skill-vendor/`, holding fetched text. Never committed: add
  `/.agentic-skill-vendor/` to `.gitignore`, anchored to the repository root, or the fetching
  commands warn. Deleting the whole directory costs one `fetch`. `verify` needs no cache — for
  a fetched contract it silently leaves out the comparisons that need the canonical text.
- **`source-mismatch`**, a violation kind: the lock pins a source to a repository
  `vendor-manifest.yaml` does not register it at. `verify` reports it and carries on, `gen` and
  `fetch` stop for that source, and `update` is the way back.
- Three report lines, on the same stability footing as `adopted` and `retired`:
  `mapped: <id> <- <source>`, `unmapped: <id>`, and `resolved: <source> <old> -> <new>`
  (a first resolution names one commit, annotated `(initial resolution)`).
- **What a fetching run holds to.** Every downloaded file is judged against the object id the
  pinned commit's own tree listing gives it, never against the lock — which is what lets one
  `fetch` rebuild the cache from any state the tree is in. A revision's cache directory is
  built under a temporary name and moved into place in one rename, so a run stopped part way
  leaves no revision behind for a later command to read as a fetch that finished. Three answers
  stop a run with nothing written: a file it was about to take listed as anything but an
  ordinary file or under a path that does not stay inside its repository; a redirect; and a
  value that would not read back as itself, the default branch `add` records included. Those
  judgments reach the two positions a conformance tree can stand hidden behind and nothing else
  a source holds — judged over the whole listing, one link or one legitimately tracked name
  such as `tests/fixtures/windows\path.txt` put every contract that source holds out of reach.
  `docs/spec/remote-sources.md` (Japanese) records why each is shaped the way it is.

### Changed

- **Breaking.** The lock file is now `vendor-lock.json`; it was `vendor-manifest.json`. A tree
  still carrying the old name is refused with a message naming both files. **Renaming the file
  is the whole migration** — its content is unchanged. The rename was forced by the new
  `vendor-manifest.yaml`: two files a letter apart in spelling and opposite in authorship is a
  confusion no message can undo.
- **Breaking.** The `verify` finding for a lock that no longer matches what the tree renders to
  is now `lock:`; it was `manifest:`. The word manifest names the declaration file from here on.
- The lock gains a `sources` section recording the commit each source is pinned at. A tree with
  no source renders the two sections it always had, byte for byte, so a repository using only
  its own contracts migrates by renaming the file and nothing else.
- Every refusal now names a command that can actually resolve the state it reports. `gen` asks
  for an `update` where the lock pins no commit for a contract's source; a `stale-lock` finding
  for a fetched contract asks for a `fetch` and then a `gen`.

### Fixed

- The package manifest no longer carries a `prepare` script running `lefthook install`. It
  never ran on registry installs, but it shipped to every consumer and did run during pack and
  git-dependency installs. Pre-push hooks are now activated once per clone with
  `bunx lefthook install`, documented in `PROJECT.md`.
- A refused request no longer states the hourly rate limit as the cause of a `403`. Anything
  filtering outbound traffic answers the same way, and the message sent readers to wait out an
  allowance that was never spent.

## [0.1.0] - 2026-08-18

### Added

- The vendoring tool: `gen` distributes each contract's current text into every skill that
  declares it and rewrites the lock to match, reporting every digest it recorded a new
  value for — a contract's text and its conformance tests on a line each; `verify`
  checks the tree against the lock with four independent checks; `lint-selfcontain` checks
  that no skill points outside its own directory; and `self-test` checks the tool against
  vectors embedded in it.
- The lock file records the dependency lists and the resolved digests, and nothing else. No
  tool version, repository URL or derivable path is written into it, so releasing a new
  version of the tool never invalidates a consuming repository's tree.
- Distribution through npm as `@ba0918-dev/agentic-skill-vendor`, run with `bunx`, `npx`,
  `pnpm dlx`, `yarn dlx` or Deno's `npm:` specifier. The tool is written against
  Node-compatible builtins and web standard APIs only, so the same source runs on Node,
  Bun and Deno, and nothing is copied into the consuming repository.
- Guarded tree access as a design property: a symlink anywhere in the tree is refused, a
  path holding a different kind of file system entity than expected stops the run instead
  of reading as absent, writes are atomic, and identity is verified byte for byte.
- A fixture tree under `fixtures/contracts-basic/good/` that verifies clean, which CI runs
  `verify` and `lint-selfcontain` against so that an unapproved change fails the build.

[Unreleased]: https://github.com/ba0918/agentic-skill-vendor/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ba0918/agentic-skill-vendor/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ba0918/agentic-skill-vendor/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ba0918/agentic-skill-vendor/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ba0918/agentic-skill-vendor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ba0918/agentic-skill-vendor/releases/tag/v0.1.0
