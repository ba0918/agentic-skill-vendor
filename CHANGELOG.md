# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
