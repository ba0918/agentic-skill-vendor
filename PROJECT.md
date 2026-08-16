# Project Context

## What this is

A general-purpose tool that deterministically distributes shared reference documents to the
skills of a skill repository and guarantees that each distributed copy is identical to its
canonical source. Those two responsibilities — distribution and identity assurance — are the
whole scope: compatibility judgment and regression detection belong to the consuming
repository's own regression machinery, not to this tool. The tool is not locked to any
particular repository; [agentic-meta](https://github.com/ba0918/agentic-meta) is the first
intended consumer, whose Python vendor machinery this tool's v1 is designed to replace.

## Stack and layout

Deno/TypeScript (Deno pinned to the 2.9.x line in CI). The source is split into modules by
responsibility under `src/`, each with its tests beside it, and is run with `deno run` —
there is no build step and no `deno compile` binary, so nothing generated needs a
reproducibility check of its own.

| Path | What it holds |
|---|---|
| `src/cli.ts` | The entry point: argument parsing and routing, no logic of its own |
| `src/errors.ts` | `ConfigError` and what the exit codes mean |
| `src/digest.ts` | Canonical text, digests, contract ids — pure, no file system |
| `src/walk.ts` | The guarded file-system primitives: the symlink-refusing walk, the atomic write, the checks other modules call before reading |
| `src/ignore.ts` | `.gitignore` rules, resolved the way git orders them |
| `src/conformance.ts` | The conformance framing rules and tree collection |
| `src/declaration.ts` | Frontmatter parsing, the declaration schema, what each skill declares |
| `src/manifest.ts` | The lock and provenance, in one canonical rendering |
| `src/gen.ts` | Distribution: what may be expanded, and writing it |
| `src/verify.ts` | The three independent identity checks |
| `src/accept.ts` | The approval boundary — the only writer of resolutions |
| `src/lint.ts` | `lint-selfcontain`: nothing inside a skill points above it |
| `src/selftest.ts` | The environment smoke check and its hand-computed vectors |
| `src/{name}.test.ts` | Each module's tests, beside the module |
| `src/testing.ts` | Test-only helpers: fixture cloning and in-process CLI runs |
| `fixtures/contracts-basic/good/` | A tree that verifies clean, cloned per test case |
| `docs/spec/` | Design decisions (Japanese) |
| `.github/workflows/ci.yml` | CI on Deno 2.9.x: the tests, then `verify` and `lint-selfcontain` over the fixture |

## Commands

| Purpose | Command |
|---|---|
| Test | `deno task test` |
| Lint | `deno task lint` |
| Format | `deno task fmt` |
| Format check | `deno task fmt:check` |

## Conventions specific to this project

- Language: `docs/spec/` is written in Japanese; everything else is written in English (the
  same convention as the sister repositories).
- A broken fixture tree is never committed. A test that needs one clones
  `fixtures/contracts-basic/good/` into a temporary directory and breaks the clone.

## Constraints

- The tool reaches two dependencies, both pinned to exact versions in `deno.json`:
  `@std/yaml` for frontmatter and `ignore` for `.gitignore` rules. Neither is a format worth
  reimplementing, and a hand-written parser for either has one failure mode this tool cannot
  afford — answering "I cannot read this" with silence. `@std/assert` and `@std/fs` are
  reached only by the tests.
- The following are external compatibility and do not change without a version change: the
  commands and their flags, the manifest schema, the exit codes, the digest algorithm and
  its normalization rules, the conformance framing rules, the byte form of the vendored copy
  header, and the violation kinds.
- The tool asks for read and write access and nothing else — no network, environment, or
  subprocess permission.

## Glossary
