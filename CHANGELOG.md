# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The vendoring tool itself, as the single file `src/vendor.ts`: `gen` distributes the
  accepted contracts into each skill, `verify` checks the tree against the lock, `accept`
  adopts new contract text and is the only writer of the lock's resolutions,
  `lint-selfcontain` checks that no skill points outside its own directory, and `self-test`
  checks the file against vectors embedded in it.
- A fixture tree under `fixtures/contracts-basic/good/` that verifies clean, which CI runs
  `verify` and `lint-selfcontain` against so that an unapproved change fails the build.
