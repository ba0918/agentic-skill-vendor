# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking.** The lock file is now `vendor-lock.json`; it was `vendor-manifest.json`. A tree
  still carrying the old name is refused with a message naming both files — renaming the file
  is the whole migration, since its content is unchanged. The rename was forced by the new
  declaration file `vendor-manifest.yaml`: two files a letter apart in spelling and opposite
  in authorship, one written by hand and one written only by the tool, is a confusion no
  message can undo.
- **Breaking.** The `verify` finding for a lock file that no longer matches what the tree
  renders to is now `lock:`; it was `manifest:`. The word manifest names the declaration file
  from here on, and a finding carrying it would send a reader to the file that check never
  opens.
- The lock gains a `sources` section recording the commit each source is pinned at. A tree
  with no source at all renders the two sections it always had, byte for byte, so a
  repository using only its own contracts migrates by renaming the file and nothing else.
- Each refusal names a way on that moves the tree it is named for. `gen` asks for an `update`
  where the lock pins no commit for a contract's source, since a `fetch` reproduces a pin
  rather than deciding one and would only ask for that same update itself. A `stale-lock`
  finding for a contract fetched from another repository asks for a `fetch` and then a `gen`,
  since its canonical text is upstream: recording whatever sits in the throwaway cache adopts
  bytes no reviewer sees in the diff the adoption lands in.

### Added

- Canonical documents may live in another public GitHub repository. `add <owner/repo> [name]`
  registers a source, records the branch that repository hands out as an explicit value,
  resolves it to a commit and takes up every declared contract it holds; `update` moves every
  pin to what its ref names now; `fetch` restores the cache from what the lock already pins.
  Those three are the only commands that reach a network, over HTTPS to `api.github.com` and
  `raw.githubusercontent.com` and nowhere else. `gen`, `verify`, `lint-selfcontain` and
  `self-test` still read and write the tree and nothing else — no network, no environment, no
  subprocess.
- `vendor-manifest.yaml`, the table of where each contract comes from. The tool is its scribe:
  `gen` writes a line for every declared contract this repository holds itself and takes out
  the lines no skill declares any more, while `add` and `update` write a line for every
  contract exactly one registered source holds. A person writes only the two things no
  derivation can decide — which source wins when several hold one contract, and where a
  canonical text sits when it is not at the conventional position. A repository with no
  source registered keeps no table and behaves exactly as before.
- Three report lines, on the same stability footing as `adopted` and `retired`:
  `mapped: <id> <- <source>`, `unmapped: <id>`, and `resolved: <source> <old> -> <new>`
  (a first resolution names one commit, annotated `(initial resolution)`).
- Fetched text is cached under `.agentic-skill-vendor/`, which is never committed: add
  `/.agentic-skill-vendor/` to `.gitignore` — anchored to the repository root — or the
  fetching commands warn. Deleting the whole directory costs one `fetch`. `verify` needs no
  cache at all: for a fetched contract it compares the copies against the lock and the lock
  against what the tree renders to, and silently leaves out the comparisons that need the
  canonical text. What it never leaves out is the lock recording nothing at all for a declared
  contract, which is reported as `unresolved` with a cache or without one: the tree an `add`
  wrote the mapping and the pin for, with no `gen` behind them, holds no vendored copy, and
  every check declining for a reason of its own left continuous integration passing a skill
  that ships without the document it declares.
- Every downloaded file is judged against the object id the pinned commit's own tree listing
  gives it, and never against the lock. A commit is immutable and says what each of its files
  hashes to, so "the cache holds what this commit holds" is established without the lock —
  which is what lets one `fetch` rebuild the cache from any state the tree is in. Bytes
  arriving as anything else stop the run with nothing written.
- A revision's cache directory is built under a temporary name and moved into place in one
  rename. A directory standing at its place therefore means that revision was fetched whole,
  and a fetching run stopped part way leaves no revision behind for a later command to read as
  a fetch that finished.
- Three answers stop a fetching run with nothing written: a file the run was about to take —
  the canonical text at its mapped path, or one of the conformance tests beside it — listed as
  anything but an ordinary file (a symlink, a submodule), a redirect — the fixed set of hosts
  would otherwise hold for the first request of a run only — and a value that would not read
  back as itself, the default branch `add` records included, which passes the same character
  check as a ref read from the table of origins. The refusal names the path and the mode, since
  what it keeps out is a file dropped from a fetch and read back as one upstream does not
  hold — a conformance tree pinned as absent while the source has one. For that same reason it
  reaches the two positions those tests can stand hidden behind, though nothing is taken from
  either: the conformance directory itself, where anything listed at all is a link or a
  subproject, and the directory that one sits in, where only those two kinds are refused. Git
  lists nothing beneath either, so tests standing under one never reach the check above; an
  ordinary file at the directory the tests sit in is left alone, since nothing can sit under a
  path a blob occupies and a contract carrying no tests is then a fact rather than something
  the fetch dropped. Everything else a source holds is ignored whatever its mode: judged over
  the whole listing instead, one link or one vendored subproject standing anywhere in a
  repository put every contract that repository holds out of reach.
- `source-mismatch`, a violation kind: the lock pins a source to a repository
  `vendor-manifest.yaml` does not register it at. The expected lock now takes that field from
  the table rather than carrying the lock's own value, which is what makes the divergence
  visible at all — compared with itself it never could be, while `fetch` went to the repository
  the lock named. `verify` reports it and carries on with its other checks, `gen` and `fetch`
  stop for that source, and `update` is the way back: it reads the repository and the ref from
  the table alone.

### Fixed

- The package manifest no longer carries a `prepare` script running `lefthook install`.
  The script never ran on registry installs, but it shipped to every consumer and did run
  during pack and git-dependency installs — a development-only concern leaking into the
  published artifact. Pre-push hooks are now activated once per clone with
  `bunx lefthook install`, documented in `PROJECT.md`.

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

[Unreleased]: https://github.com/ba0918/agentic-skill-vendor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ba0918/agentic-skill-vendor/releases/tag/v0.1.0
