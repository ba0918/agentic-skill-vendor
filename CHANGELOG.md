# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The vendoring tool itself, run as `src/cli.ts`: `gen` distributes the accepted contracts
  into each skill, `verify` checks the tree against the lock, `accept` adopts new contract
  text and is the only writer of the lock's resolutions, `lint-selfcontain` checks that no
  skill points outside its own directory, and `self-test` checks the tool against vectors
  embedded in it.
- A fixture tree under `fixtures/contracts-basic/good/` that verifies clean, which CI runs
  `verify` and `lint-selfcontain` against so that an unapproved change fails the build.
- Source split into modules by responsibility under `src/`, each with its tests beside it,
  entered through `src/cli.ts`, which routes and holds no logic of its own.

### Changed

- Conformance digests now exclude the files the tree's own `.gitignore` rules exclude,
  read from the root down to the conformance directory and inside it, nested rules and
  negations included. The `__pycache__` directory is no longer excluded by name: a tree
  that relied on that and carries no rule covering it will report a conformance mismatch
  until a rule is added or the new digest is accepted. Editing a `.gitignore` can change a
  conformance digest.
- A skill's declarations are read as YAML and then judged against a schema, so every YAML
  spelling of a list of ids under `metadata.contracts` is accepted — flow lists, flow
  mappings, entries at the `contracts` key's own indent, quoted ids. Declaring a digest
  beside an id is still refused.
- A declaration the tool cannot make sense of now stops the run with exit `2` instead of
  being read as "this skill declares nothing". That covers frontmatter YAML cannot parse,
  a tab in the indentation, a `metadata` key that is not a mapping, a `contracts` value
  that is not a non-empty list, and an entry that is not text.
- A document whose opening `---` is not exactly `---` — a trailing space, a tab, a lone
  carriage return, a zero-width character (U+200B–U+200D) — stops the run with exit `2`. It
  was read as "this document has no frontmatter", which dropped the entire declaration
  block: `gen` then finished cleanly while deleting the skill's vendored copies and its
  dependency edge. The same refusal applies to a contract document, whose frontmatter would
  otherwise be digested as body.
- A document that reaches its opening `---` with only blank lines above it stops the run
  with exit `2` as well, for the same reason and by the same route: a single blank line at
  the top was enough to drop the whole block. A horizontal rule at the very top of a body
  separates nothing, so no document that meant something is refused by this.
- The tool runs on Node, Bun and Deno from the same source: it uses Node-compatible builtins
  and web standard APIs only, and no runtime's own API. Its distribution is now the npm
  registry — run it with `bunx`, `npx`, `pnpm dlx`, `yarn dlx`, or Deno's `npm:` specifier,
  with nothing copied into the consuming repository. Syncing a single `.ts` file at a pinned
  digest is no longer how it is consumed, and the sha256-then-`self-test` check that went
  with it no longer applies; `self-test` remains as the environment smoke check.
- Frontmatter is parsed by `js-yaml` rather than `@std/yaml`. Every declaration shape that
  was accepted is still accepted and every one that was refused is still refused; what
  changes is that a Deno run needs no environment permission to parse it.
- `--root` given an empty path is a usage error. It was reduced to `/`, so an unset shell
  variable pointed the run at the file system root.
- `provenance.contracts` names only the contracts whose canonical file the tree holds, so a
  withdrawn contract no longer leaves a source path pointing at a file that is not there.

### Fixed

- A symlink whose path names no directory is resolved against the current directory rather
  than against the path with its last character removed, which could place a link's target
  outside the directory it was judged against.
