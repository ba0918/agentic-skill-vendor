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

Deno/TypeScript (Deno pinned to the 2.9.x line in CI). The tool ships as a single `.ts`
source file that consumers sync at a fixed digest and run with `deno run` — no `deno compile`
binary distribution.

| Path | What it holds |
|---|---|
| `src/vendor.ts` | The tool. The whole distributed artifact, in one file |
| `tests/` | The tool's test suite, plus `helpers.ts` |
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

- `src/vendor.ts` imports nothing. A consumer accepts the file by checking one sha256, so
  every behaviour it has must be inside that hash; an import would put code, and a network
  dependency, outside it. The test suite is not distributed, so it may use JSR packages
  (pinned in `deno.json`).
- The following are external compatibility and do not change without a version change: the
  commands and their flags, the manifest schema, the exit codes, the digest algorithm and
  its normalization rules, the conformance framing rules, the byte form of the vendored copy
  header, and the violation kinds.
- The tool asks for read and write access and nothing else — no network, environment, or
  subprocess permission.

## Glossary
