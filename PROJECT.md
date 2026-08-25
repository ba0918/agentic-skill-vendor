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
| `src/cli.ts` | The package entry point: started-program detection and the CLI runner re-export |
| `src/cli/run.ts` | Argument parsing and routing, standard input, output, and exit codes |
| `src/errors.ts` | `ConfigError` and what the exit codes mean |
| `src/records.ts` | Prototype-free maps for keys the tree supplies, so `__proto__` and inherited property names behave as ordinary keys |
| `src/filesystem/walk.ts` | The guarded file-system primitives: the symlink-refusing walk, the atomic write, the checks other modules call before reading |
| `src/filesystem/ignore.ts` | `.gitignore` rules, resolved the way git orders them |
| `src/contracts/digest.ts` | Canonical text, digests, contract ids — pure, no file system |
| `src/contracts/conformance.ts` | The conformance framing rules and tree collection |
| `src/contracts/declaration.ts` | Frontmatter parsing, the declaration schema, what each skill declares |
| `src/contracts/manifest.ts` | The lock, in one canonical rendering, and what that rendering takes from the table of origins rather than from the lock |
| `src/contracts/sources.ts` | The table of where each contract comes from: its schema, and the line-by-line editing that keeps a person's own lines intact |
| `src/contracts/distribution-ignore.ts` | Validation and matching of the shared and contract-specific distribution `ignore` rules |
| `src/contracts/repository.ts` | Pure allowlist classification of GitHub shorthand and generic SSH/HTTPS repository forms |
| `src/contracts/raw.ts` | Raw-byte contracts, pure: the shared framing, the contract digest and the placement digest |
| `src/contracts/placement-ownership.ts` | Pure per-skill final-dest conflict checks and old-to-final overlap component derivation |
| `src/distribution/gen.ts` | Distribution: the lock derived from the canonical text, and writing both |
| `src/distribution/header.ts` | The generated-copy header, shared by document copies and raw-byte markers |
| `src/distribution/rawsource.ts` | Reading a raw-byte contract's files from the tree or the cache, with the refusals that go with it |
| `src/distribution/placements.ts` | Distributing raw-byte contracts: the gate, ownership-migration state classification, the sweep, the placement record, and verify's checks over them |
| `src/distribution/staging.ts` | Building a raw-byte dest under the tool's directory and renaming it into the skill |
| `src/distribution/verify.ts` | The four independent identity checks |
| `src/distribution/lint.ts` | `lint-selfcontain`: nothing inside a skill points above it |
| `src/remote/cache.ts` | Where fetched text is kept — a revision's directory is the unit a whole fetch is placed at — how it is cleared, and whether the repository ignores it |
| `src/remote/token.ts` | The GitHub API credential: taken from standard input, judged before it can become a header, named by no refusal |
| `src/remote/github.ts` | The two hosts, the request shapes and the response schema — over an injected transport |
| `src/remote/remote.ts` | The snapshot lifecycle shared by remote transports and the repository-kind router |
| `src/remote/git.ts` | Generic Git snapshots: ref/pin acquisition, tree listing and streamed object verification over an injected runner |
| `src/remote/gitprocess.ts` | The real shell-free, non-interactive Git process group and its cumulative time, disk and extraction budgets |
| `src/remote/resolvecmd.ts` | `fetch` and `update`, and the fetch-then-verify-then-write path they share |
| `src/remote/addcmd.ts` | `add`: registering a source, then everything `update` does |
| `src/diagnostics/selftest.ts` | The environment smoke check and its hand-computed vectors |
| `src/{feature}/{name}.test.ts` | Each module's tests, beside the module |
| `src/test-support/testing.ts` | Test-only helpers: fixture cloning and in-process CLI runs |
| `src/test-support/source-layout.test.ts` | The frozen file inventory and import-boundary architecture checks |
| `fixtures/contracts-basic/good/` | A tree that verifies clean, cloned per test case |
| `fixtures/contracts-remote/good/` | The same, for a tree taking one contract from another repository — committed with the cache that contract's text sits in, so the offline guarantee is checked against a tree that actually has one |
| `fixtures/contracts-raw/good/` | The same, for a tree distributing raw bytes — a directory of scripts and one file — into two skills at the dests its table names |
| `docs/spec/` | Design decisions (Japanese) |
| `package.json` | The npm package: `bin`, the scripts below, and the exact-pinned dependencies |
| `tsconfig.json` | Type checking only — the published artifact comes from `bun build` |
| `biome.json` | Lint and format, and the rules this codebase turns off |
| `.github/workflows/ci.yml` | CI on Bun 1.3.x: the type check, lint, format check and tests, then `verify` and `lint-selfcontain` over all fixtures, followed by packed-artifact smokes on Node, Bun and Deno |
| `.github/workflows/release.yml` | The release: a push to main that carries a version bump is tagged and published to npm, with the checks above called rather than restated |

The canonical project version is the `version` field in `package.json`. Release headings and
tags follow that value; they are not separate version declarations.

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
- No test reaches a network. The transports are injected at the command boundary, and the
  suite's default HTTP and generic Git capabilities refuse accidental use. Fetching tests use
  deterministic fake GitHub snapshots or injected process, file-system and time boundaries;
  process-group and capacity behavior never depends on a real server, PTY, `/proc` or `ps`.

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
- A GitHub API credential reaches the tool on standard input alone, only where `--token-stdin`
  asks for it and a GitHub API source is actually used, at most once per run. Only the three
  commands that reach a network accept the flag. Not a file: that is a
  second copy
  of the secret at rest, and making one safe needs a mode check that says nothing on a file
  system without POSIX modes. Not an environment variable: that could be inherited by a child
  process and would cost `--allow-env` besides. Standard input needs
  no permission of its own, so the Deno flags the commands document do not change. The value
  is held for one run, reaches only the `Authorization: Bearer` header of each request to the
  two fixed hosts, never reaches generic Git, is written nowhere and is named by no refusal —
  the refusals report a position instead. Reading standard input is the one part of this path
  that is a runtime capability rather than this package's own code, so CI asserts it on Node, Bun and Deno
  against the packed tarball.
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
- Raw-byte dest ownership is scoped to a skill. `gen` and `verify` reject identical or nested
  final dests within that skill, while table parsing and the non-placement commands do not apply
  that tree-dependent check. An old placement overlapping its replacement is planned as one
  outermost staged write only after the intact-old digest and newly-owned-content gates pass;
  interrupted runs converge only from the old, absent, or exact-complete state. This changes no
  lock field and grants no command additional network, environment, or subprocess access.
- `gen`, `verify`, `lint-selfcontain` and `self-test` reach the file system and nothing else
  — no network, no environment, no subprocess. Under Deno that is enforceable with
  `--allow-read --allow-write`; on Node and Bun there is no sandbox to enforce it with, so it
  is a property of the code rather than a guarantee of the runtime. `add`, `update` and
  `fetch` route `owner/repo` through HTTPS to `api.github.com` and
  `raw.githubusercontent.com`; no redirect is followed, because the fixed pair of hosts would
  otherwise hold for the first request only. Allowlisted SSH, scp-style SSH and HTTPS URLs
  instead use installed Git/OpenSSH through an injected runner. This generic path preserves
  trusted system/global configuration and non-prompting authentication, strips dangerous
  per-run environment overrides, disables Git/OpenSSH prompts even on a TTY, and closes stdin.
  Under Deno it therefore needs environment, temporary-directory read/write and
  `--allow-run=git` permissions. The four offline commands refuse `--token-stdin` rather than
  ignoring it, so their narrower boundary is stated in the one place a person checks it.
- Every generic Git command runs in its own detached process group, and each fetched snapshot
  uses a temporary bare repository. The source-wide cumulative defaults are 120 seconds,
  256 MiB of temporary disk, 1 MiB per extracted file
  and 256 MiB across extracted files. A failed process, timeout or capacity excess normally
  terminates the detached group and deletes its temporary bare repository. If the OS cannot
  confirm that the group has stopped, the tool fails safely and retains that exact repository
  under the OS temporary directory with the `agentic-skill-git-` prefix. Cache, manifest and
  lock state remain unchanged, and raw child diagnostics are suppressed. The refusal identifies
  the exact outer retained directory and detached process group. Recovery requires first
  confirming that the named group has stopped, then manually deleting only that exact
  retained directory; recursive removal is allowed for that exact directory after confirmation.
  Never recursively clean the OS temporary root or a parent directory, choose a target with a
  glob, or rely on unresolved variables.
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
