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
| `src/manifest.ts` | The lock, in one canonical rendering, and what that rendering takes from the table of origins rather than from the lock |
| `src/sources.ts` | The table of where each contract comes from: its schema, and the line-by-line editing that keeps a person's own lines intact |
| `src/distribution-ignore.ts` | Validation and matching of the shared and contract-specific distribution `ignore` rules |
| `src/cache.ts` | Where fetched text is kept — a revision's directory is the unit a whole fetch is placed at — how it is cleared, and whether the repository ignores it |
| `src/github.ts` | The two hosts, the request shapes and the response schema — over an injected transport |
| `src/resolvecmd.ts` | `fetch` and `update`, and the fetch-then-verify-then-write path they share |
| `src/addcmd.ts` | `add`: registering a source, then everything `update` does |
| `src/gen.ts` | Distribution: the lock derived from the canonical text, and writing both |
| `src/header.ts` | The generated-copy header, shared by document copies and raw-byte markers |
| `src/raw.ts` | Raw-byte contracts, pure: the shared framing, the contract digest and the placement digest |
| `src/rawsource.ts` | Reading a raw-byte contract's files from the tree or the cache, with the refusals that go with it |
| `src/placements.ts` | Distributing raw-byte contracts: the gate, the sweep, the placement record, and verify's checks over them |
| `src/staging.ts` | Building a raw-byte dest under the tool's directory and renaming it into the skill |
| `src/verify.ts` | The four independent identity checks |
| `src/lint.ts` | `lint-selfcontain`: nothing inside a skill points above it |
| `src/selftest.ts` | The environment smoke check and its hand-computed vectors |
| `src/{name}.test.ts` | Each module's tests, beside the module |
| `src/testing.ts` | Test-only helpers: fixture cloning and in-process CLI runs |
| `fixtures/contracts-basic/good/` | A tree that verifies clean, cloned per test case |
| `fixtures/contracts-remote/good/` | The same, for a tree taking one contract from another repository — committed with the cache that contract's text sits in, so the offline guarantee is checked against a tree that actually has one |
| `fixtures/contracts-raw/good/` | The same, for a tree distributing raw bytes — a directory of scripts and one file — into two skills at the dests its table names |
| `docs/spec/` | Design decisions (Japanese) |
| `package.json` | The npm package: `bin`, the scripts below, and the exact-pinned dependencies |
| `tsconfig.json` | Type checking only — the published artifact comes from `bun build` |
| `biome.json` | Lint and format, and the rules this codebase turns off |
| `.github/workflows/ci.yml` | CI on Bun 1.3.x: the type check, lint, format check and tests, then `verify` and `lint-selfcontain` over both fixtures |
| `.github/workflows/release.yml` | The release: a push to main that carries a version bump is tagged and published to npm, with the checks above called rather than restated |

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
| Enable pre-push hooks (once per clone) | `bunx lefthook install` |

## Conventions specific to this project

- Language: `docs/spec/` is written in Japanese; everything else is written in English (the
  same convention as the sister repositories).
- A broken fixture tree is never committed. A test that needs one clones
  `fixtures/contracts-basic/good/` into a temporary directory and breaks the clone.
- No test reaches a network. The transport is injected at the command boundary, and the one
  the suite hands the entry point refuses every request, so a command that reached for a
  network where it must not fails rather than connecting. The fetching commands are driven
  by a fake GitHub that answers in the shapes the real service answers in.

## Constraints

- The tool reaches two dependencies, both pinned to exact versions in `package.json`:
  `js-yaml` for frontmatter and `ignore` for `.gitignore` rules. Neither is a format worth
  reimplementing, and a hand-written parser for either has one failure mode this tool cannot
  afford — answering "I cannot read this" with silence. `js-yaml` is also the one of the two
  candidates that reads no environment variable, which is what lets a Deno run stay on read
  and write alone. Biome, TypeScript, `@types/bun` and lefthook are development-only and never ship.
- `bun test` strips types rather than checking them, so `bun run typecheck` is a step of its
  own in CI. Without it the settings in `tsconfig.json` would constrain nothing.
- The published artifact keeps those two external rather than bundling them, so a consuming
  repository's audit sees the dependency graph the tool actually has.
- The following are external compatibility and do not change without a version change: the
  commands and their flags, the lock schema (`placements` and a resolution's `kind` included),
  the declaration schema (`files` lines included), the exit codes, the digest algorithm and
  its normalization rules, the framing rules shared by conformance, contract and placement
  digests, the byte form of the vendored copy header and of the `.vendored` marker, the
  violation kinds, and the report lines.
- A raw-byte dest is built under `.agentic-skill-vendor/staging/` and renamed into the skill,
  never built in place: a temporary name inside a skill is the person's, and the gate never
  looks at it. The rename needs one file system; a tree whose tool directory sits on another
  is refused before anything is removed.
- `gen`, `verify`, `lint-selfcontain` and `self-test` reach the file system and nothing else
  — no network, no environment, no subprocess. Under Deno that is enforceable with
  `--allow-read --allow-write`; on Node and Bun there is no sandbox to enforce it with, so it
  is a property of the code rather than a guarantee of the runtime. `add`, `update` and
  `fetch` add HTTPS to `api.github.com` and `raw.githubusercontent.com`, through a transport
  injected at the command boundary, and read no environment variable and start no subprocess
  either. No redirect is followed: the fixed pair of hosts would otherwise hold for the first
  request of a run only, so a `3xx` answer stops the run with nothing written.
- The lock records what was resolved and nothing else — no tool version, no repository URL, no
  derivable path. Every one of those was a value no check consumed, and the tool's own
  version put a byte nobody verified into a byte-for-byte comparison: releasing a new
  version made every consuming repository's `verify` fail until each tree was regenerated.
  The one thing it gained is the `sources` section, which records the commit each source is
  pinned at — a value the fetching commands write and every offline command reads. The
  repository recorded beside it is the one `vendor-manifest.yaml` registers: the rendering
  takes that field from the table instead of carrying the lock's own value, so a lock naming
  another repository is reported (`source-mismatch`) rather than compared with itself, and
  `gen` and `fetch` stop for that source while `update` — which reads the repository and the
  ref from the table alone — is the way back.
  A format marker is deliberately absent too; a future breaking release introduces one, and
  the absence of the field is what marks the older form.
- The canonical text is the authority and the lock is derived from it, so `gen` is the only
  writer of resolutions and the only command that reports `adopted` / `retired`. Each digest
  it recorded a new value for gets a line: a contract's text and its conformance tests move
  independently, so they are never folded into one. What guards a change of contract text is
  the review of the pull request the rewritten lock lands in — the tool has no approval
  boundary of its own.
