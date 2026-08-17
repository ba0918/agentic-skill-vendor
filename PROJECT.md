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

TypeScript, written against Node-compatible builtins (`node:fs/promises`, `node:url`, …) and
web standard APIs (Web Crypto) only, so the same source runs on Node, Bun and Deno. The
development toolchain is Bun (running, testing, package management), with Biome for lint and
format; CI runs on the Bun 1.3.x line. The source is split into modules by responsibility
under `src/`, each with its tests beside it. Distribution is npm: `bun build` produces the
Node-compatible `dist/cli.js` the package's `bin` points at, when the tarball is packed, and
it is never committed.

| Path | What it holds |
|---|---|
| `src/cli.ts` | The entry point: argument parsing and routing, no logic of its own |
| `src/errors.ts` | `ConfigError` and what the exit codes mean |
| `src/records.ts` | Prototype-free maps for keys the tree supplies, so `__proto__` and inherited property names behave as ordinary keys |
| `src/digest.ts` | Canonical text, digests, contract ids — pure, no file system |
| `src/walk.ts` | The guarded file-system primitives: the symlink-refusing walk, the atomic write, the checks other modules call before reading |
| `src/ignore.ts` | `.gitignore` rules, resolved the way git orders them |
| `src/conformance.ts` | The conformance framing rules and tree collection |
| `src/declaration.ts` | Frontmatter parsing, the declaration schema, what each skill declares |
| `src/manifest.ts` | The lock, in one canonical rendering |
| `src/gen.ts` | Distribution: the lock derived from the canonical text, and writing both |
| `src/verify.ts` | The four independent identity checks |
| `src/lint.ts` | `lint-selfcontain`: nothing inside a skill points above it |
| `src/selftest.ts` | The environment smoke check and its hand-computed vectors |
| `src/{name}.test.ts` | Each module's tests, beside the module |
| `src/testing.ts` | Test-only helpers: fixture cloning and in-process CLI runs |
| `fixtures/contracts-basic/good/` | A tree that verifies clean, cloned per test case |
| `docs/spec/` | Design decisions (Japanese) |
| `package.json` | The npm package: `bin`, the scripts below, and the exact-pinned dependencies |
| `tsconfig.json` | Type checking only — the published artifact comes from `bun build` |
| `biome.json` | Lint and format, and the rules this codebase turns off |
| `.github/workflows/ci.yml` | CI on Bun 1.3.x: the type check, lint, format check and tests, then `verify` and `lint-selfcontain` over the fixture |

## Commands

| Purpose | Command |
|---|---|
| Install the locked dependencies | `bun install --frozen-lockfile` |
| Type check | `bun run typecheck` |
| Test | `bun test` |
| Lint | `bun run lint` |
| Format | `bun run fmt` |
| Format check | `bun run fmt:check` |
| Build the publishable artifact | `bun run build` |
| Run the tool from source | `bun run src/cli.ts <command> [--root <path>]` |

## Conventions specific to this project

- Language: `docs/spec/` is written in Japanese; everything else is written in English (the
  same convention as the sister repositories).
- A broken fixture tree is never committed. A test that needs one clones
  `fixtures/contracts-basic/good/` into a temporary directory and breaks the clone.

## Constraints

- The tool reaches two dependencies, both pinned to exact versions in `package.json`:
  `js-yaml` for frontmatter and `ignore` for `.gitignore` rules. Neither is a format worth
  reimplementing, and a hand-written parser for either has one failure mode this tool cannot
  afford — answering "I cannot read this" with silence. `js-yaml` is also the one of the two
  candidates that reads no environment variable, which is what lets a Deno run stay on read
  and write alone. Biome, TypeScript and `@types/bun` are development-only and never ship.
- `bun test` strips types rather than checking them, so `bun run typecheck` is a step of its
  own in CI. Without it the settings in `tsconfig.json` would constrain nothing.
- The published artifact keeps those two external rather than bundling them, so a consuming
  repository's audit sees the dependency graph the tool actually has.
- The following are external compatibility and do not change without a version change: the
  commands and their flags, the manifest schema, the exit codes, the digest algorithm and
  its normalization rules, the conformance framing rules, the byte form of the vendored copy
  header, and the violation kinds.
- The tool reaches the file system and nothing else — no network, no environment, no
  subprocess. Under Deno that is enforceable with `--allow-read --allow-write`; on Node and
  Bun there is no sandbox to enforce it with, so it is a property of the code rather than a
  guarantee of the runtime.
- The manifest records the lock and nothing else — no tool version, no repository URL, no
  derivable path. Every one of those was a value no check consumed, and the tool's own
  version put a byte nobody verified into a byte-for-byte comparison: releasing a new
  version made every consuming repository's `verify` fail until each tree was regenerated.
  A format marker is deliberately absent too; a future breaking release introduces one, and
  the absence of the field is what marks the older form.
- The canonical text is the authority and the lock is derived from it, so `gen` is the only
  writer of resolutions and the only command that reports `adopted` / `retired`. What guards
  a change of contract text is the review of the pull request the rewritten lock lands in —
  the tool has no approval boundary of its own.
