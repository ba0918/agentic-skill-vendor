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

- The package is published as `@ba0918/agentic-skill-vendor` and its command is
  `agentic-skill-vendor`. The earlier names — `@ba0918/skill-shared-reference-vendor` and
  `skill-vendor` — said neither what is vendored nor where to. The `usage:` line names the
  command as well; it named `cli.ts`, a source file nobody types.
- `provenance.generator.name` is `agentic-skill-vendor`, and is fixed there from now on. It
  was `vendor.ts`, the name of the single file this tool used to be. The name sits in bytes
  `verify` compares exactly, so moving it reports every generated copy as drift — which is
  why it is moved now, while nothing has been released and no copy exists to break.
- `provenance.generator.version` is the package's own version, read from `package.json`
  rather than written out a second time. It read `1.0.0` while the package read `0.1.0`, so
  provenance named a release that had never happened. A consequence for this repository:
  bumping the version makes the committed fixture stale until `gen` is run over it, and
  CI's fixture `verify` fails until it is.
- The development toolchain is Bun. The Deno configuration is gone, tests run under
  `bun test`, lint and formatting are Biome, and CI runs the type check, lint, format check
  and tests on the Bun 1.3.x line before checking the fixture tree. This is visible only to
  someone working from a checkout; the tool itself still runs on Node, Bun and Deno alike.
- The published tarball is built when it is packed rather than only when it is published, so
  `npm pack` can no longer produce an archive whose `bin` points at a file that is not in it.
- A root that names no directory stops every command that reads a tree with exit `2`. Under
  `verify` it was exit `1`: a tree that is not there reads as a tree in which every file is
  missing, and the run reported that as drift rather than as the mistake it was.
- `--root` followed by another flag is a usage error. `--root --help` ran against a tree
  named `--help` and never printed the help it was asked for.
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
  carriage return, or any character Unicode marks as showing nothing, such as a zero-width
  space, a word joiner or a bidi mark — stops the run with exit `2`. It
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
- Frontmatter is parsed by `js-yaml` rather than `@std/yaml`, which is what lets a Deno run
  parse it without environment permission. Every shape of a declaration is still read the
  same way, merge keys (`<<`) included, and no shape that declared contracts before is now
  read as declaring nothing. Two ids resolve differently at the edge, and both differences
  are reported rather than silent: an id written `0o17` is now refused, because YAML 1.2
  reads it as a number where the previous parser read it as text; an id written
  `2001-12-14` is now accepted as that text, where the previous parser read it as a date
  and refused it.
- `--root` given an empty path is a usage error. It was reduced to `/`, so an unset shell
  variable pointed the run at the file system root.
- `provenance.contracts` names only the contracts whose canonical file the tree holds, so a
  withdrawn contract no longer leaves a source path pointing at a file that is not there.

### Fixed

- A directory symlinked out of the tree is refused rather than followed. With `contracts/`
  or `contracts/<id>/` replaced by a link, `accept` pinned the digest of a file outside the
  tree, wrote outside text into every vendored copy, recorded provenance naming a path the
  tree does not hold, and `verify` then reported the result as clean. Links standing in for
  a single file were already refused; the directory shapes were not. Every command that
  reads `contracts/` — `gen`, `verify` and `accept` — answers a planted link there the same
  way. A link at `contracts/<id>/`, or at the `conformance/` directory below it, stopped
  `verify`, which digests the tests there, while `gen` finished cleanly and said nothing;
  accepting a different contract carried on too, and so did both of them for a contract no
  skill declares any more, one the lock alone still names. Whether a link is refused is a
  fact about the tree, so it depends neither on which command is looking, nor on which
  contract that command was pointed at, nor on whether the contract is still declared.
- A read that fails for a reason other than the file being absent — a permission error, most
  of all — is reported on standard error with exit `2`. It escaped as an uncaught exception,
  which ended the run with a stack trace and exit `1`, the code that means the tree was
  examined and found in violation.
- Every path a message names is spelled as the tree spells it — a refusal and a read that
  failed alike. The same refusal was reported with an absolute path by `verify` and a
  tree-relative one by `gen`; once that was settled the read failures were still mixed among
  themselves, so one unreadable file was named absolutely when the failure came from looking
  at it and tree-relatively when it came from reading its content. Where the run could not
  look at all, the underlying error is still quoted and carries the absolute path, and the
  tree root itself is named as it was given.
- A symlink whose path names no directory is resolved against the current directory rather
  than against the path with its last character removed, which could place a link's target
  outside the directory it was judged against. The same mistake in the creation of a parent
  directory is fixed with it: a name holding no separator had its last character cut off,
  and the directory made was a sibling of the file rather than the one holding it.
- Every path where the tree is expected to hold a directory or a file is refused when it
  holds something else, on every command that reads it, with exit `2` naming the path. The
  two questions "is anything there" and "is it what it should be" were answered as one, so a
  regular file, a named pipe or a socket standing at such a path read as "nothing there yet"
  and the run took the branch written for an empty tree: a regular file at `skills/` emptied
  the lock of every dependency while `gen` reported `0`, and `verify` then called that tree
  clean. It reached `contracts/<id>/conformance`, a skill's `references/vendor`, a vendored
  copy, the manifest and a conformance tree's `.gitignore` alike. Paths that genuinely hold
  nothing are unchanged in every case — a tree with no `skills/` still adopts cleanly, a
  contract with no conformance tests still pins none, a missing canonical file is still a
  closure gap, and a missing copy is still drift.
- A skill whose directory is named `__proto__` is recorded like any other. Skill names are
  directory names and nothing validates them, but assigning one into an ordinary object
  writes that object's prototype instead of adding a key, so the skill vanished from the
  lock: `gen` wrote a manifest without it at exit `0`, and `verify`, building its expectation
  the same way, called that clean. The same rebuilding happens when a manifest is rendered
  again, so a lock already holding such a key lost it on the next write. The maps keyed by
  names the tree supplies are made without a prototype now; no rule about what a skill may be
  called is introduced. A contract id that names an inherited property — `constructor` — is
  affected the same way in reverse: looking one up found `Object`'s own constructor instead
  of nothing, and an unaccepted contract was reported as text drifting from a digest of
  `undefined` rather than as never accepted.
- A manifest whose `lock.dependencies` is not an object is refused with exit `2` rather than
  read as though it held nothing, which is how `lock` and `lock.resolutions` were already
  treated. It reached `verify`, which reported such a manifest as a violation at exit `1`,
  and `gen`, which rewrote it at exit `0`.
- A path the run would write at is refused unless it is a regular file to be replaced or
  nothing at all, and the temporary file beside it is held to the same rule. Writing goes
  through that temporary, so a named pipe standing at either one was opened for writing and
  waited for a reader that never came: `gen` and `accept` stopped answering, and where the
  pipe stood at the manifest's temporary path `verify` called the tree clean while they did.
  A pipe standing where a vendored copy belongs was not a hang but a silent replacement —
  the copy was renamed over it at exit `0` while `verify` refused the same tree. Nothing at
  such a path is removed by the refusal; the run declines to write, and says where.
- A name recorded in the lock as a skill is refused when something other than a directory
  stands at it, naming the path. Replacing `skills/<name>/` with a file of the same name read
  as "no such skill": the lock was rewritten without it at exit `0` and the vendored copies
  it accounted for were deleted, so a whole skill retired because a file appeared over its
  directory. Only names the lock already records are held to this — a stray file beside the
  skills, a `README.md` and the like, is ignored exactly as before, and no rule about what
  may sit under `skills/` is introduced. A skill directory removed outright is still a
  removal, and the lock still follows it.
- A path the run would read is refused unless it is a regular file, rather than opened and
  read. A named pipe read as an ordinary file does not fail: it blocks until something on the
  other side writes, so one placed in a conformance tree left `verify` running forever, one
  inside a skill did the same to `lint-selfcontain`, and one standing at the manifest — read
  by every command before it does anything else — did it to `gen`, `verify` and `accept`
  alike.
- A `SKILL.md` that is there but is not a regular file — a directory, a named pipe, a socket
  — stops the run with exit `2` naming it. It answered exactly as no `SKILL.md` at all does,
  so the skill read as declaring nothing: `gen` deleted the vendored copies its declarations
  accounted for and finished at `0`, and `verify` then called the result clean. Nothing about
  the document's content was wrong, which is what every earlier guard of this family looked
  at. A skill directory genuinely holding no `SKILL.md` still declares nothing, and is still
  scanned for copies no declaration accounts for.
- A contract's canonical file that is there but is not a regular file stops the run with
  exit `2` naming it, on every command that reads `contracts/`. It is the same conflation one
  document over: a contract no skill declares any more, one the lock alone still names,
  dropped out of the provenance record without a word while `gen` finished at `0` and
  `verify` called the tree clean. A canonical file genuinely absent is still what it was —
  reported as a closure gap for a contract a skill declares, and left out of provenance for
  one nothing declares — and that report now names a file that really is not there.
- An argument a command has no use for is a usage error naming it, rather than a word quietly
  dropped. `verify some-tree` — a `--root` forgotten — ran against the current directory and
  reported `0` for a tree nobody asked about. The contract ids `accept` is given are what it
  is given; nothing there changes.
- A stale vendored copy that cannot be removed stops the run with exit `2` naming it. The
  failure was passed over, so `gen` finished at `0` while `verify` reported the leftover as an
  extra, and running `gen` again changed neither answer. Removals still run last, so nothing
  is abandoned: every copy and the lock are already written, and every removal is attempted
  before the run stops. A path already gone is the state the removal asked for, not a failure.
