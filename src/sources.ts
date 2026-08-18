// sources.ts — where each contract's canonical text lives, as the tree declares it.
//
// The declaration is one table over every contract the repository uses, local
// and remote alike, and the tool is its scribe: `add` registers a source,
// `gen`, `add` and `update` write the mapping lines they derive, and a person
// writes only the two things no derivation can decide — which source wins when
// several hold the same id, and where a canonical text sits when it is not at
// the conventional position.
//
// Reading is a parse-then-judge pair, the same shape declaration.ts uses on a
// skill's frontmatter and for the same reason: a hand-written line grammar has
// to decide what every unfamiliar shape means, and its answer for "I cannot
// read this" is silence. Here silence would be worse than in a skill, because
// an unread mapping reads as "this contract is local" and sends the run to a
// file that does not exist.

import { load as parseYaml } from "js-yaml";
import { ConfigError, describeCause } from "./errors.ts";
import { assertValidContractId, contractPath } from "./digest.ts";
import { emptyRecord } from "./records.ts";
import { SKILLS_DIR } from "./declaration.ts";
import {
  assertPlainChain,
  isRegularFileOrAbsent,
  readTextFile,
} from "./walk.ts";

/** The one file the declaration lives in. */
export const DECLARATION_FILE = "vendor-manifest.yaml";

/**
 * The source name standing for this repository itself.
 *
 * Reserved rather than merely conventional: a registered source of this name
 * would make `source: local` ambiguous between "the text is here" and "the
 * text is over there", and a mapping the reader cannot resolve by eye is the
 * one thing this table exists to prevent.
 */
export const LOCAL_SOURCE = "local";

/**
 * What a source name, a repository and a ref may be made of.
 *
 * Every one of the three reaches somewhere a loose value must not: the name
 * becomes a directory under the cache, and the other two are interpolated into
 * the request the fetch commands make. Checked as an allowlist rather than as
 * a list of dangerous spellings, so a shape nobody thought of is refused
 * rather than passed through.
 *
 * A ref keeps its separators, unlike the other two: `release/2.x` is a legal
 * branch and may even be a repository's default one, so a blanket ban on `/`
 * would refuse trees that are perfectly ordinary. What is refused instead is
 * every spelling that could change which commit — or which URL — the value
 * names: a double dot, an empty segment, a leading dash that would read as an
 * option, and git's own revision punctuation.
 */
const SOURCE_NAME_FORM = /^[a-z0-9][a-z0-9._-]*$/;
const REPOSITORY_FORM =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_FORM = /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const NAME_LIMIT = 64;

/**
 * The directory the tool keeps its own working state in, cache included.
 *
 * Named here rather than beside the cache that fills it, because the first
 * thing the tree has to know about it is that no canonical text may live
 * inside it — a rule about what a declaration may say, which is this module's
 * business. The cache layer builds its own paths on top of this one.
 */
export const TOOL_DIR = ".agentic-skill-vendor";

/** A registered source: the repository to fetch from, and what to fetch. */
export interface SourceRecord {
  repository: string;
  /**
   * A branch, a tag or a commit SHA. What the lock records is always a commit
   * SHA; this is the question the fetch commands ask, not the answer.
   */
  ref: string;
}

/**
 * Where one contract's canonical text lives: which source holds it, and — only
 * where it is not at the conventional position — at which path inside that
 * source.
 *
 * `path` means the same thing for every source, `local` included. What makes
 * local special is that nothing has to be fetched, not that it is addressed
 * differently.
 */
export interface ContractOrigin {
  source: string;
  path?: string;
}

export interface Declaration {
  sources: Record<string, SourceRecord>;
  contracts: Record<string, ContractOrigin>;
}

/**
 * Where a run reads one contract's canonical text, and who answers for it.
 *
 * `site` is null for a contract this tree does not hold the text of: a remote
 * one whose bytes are not in the cache. That is a state, not a fault — a clean
 * checkout is in it — and the commands part ways over it: gen asks for a fetch,
 * verify checks what it still can.
 *
 * Stated here rather than beside the code that computes it, because both the
 * lock's rendering and the distribution read it, and the two must not be able
 * to hold different ideas of where a contract's text is.
 */
export type ContractLocation =
  /** This repository is the authority: the text is at `site`, or nowhere. */
  | { local: true; site: string }
  /** Another repository is: the text is in the cache at `site`, or not yet. */
  | { local: false; site: string | null };

/**
 * Where a contract's canonical text sits inside the source that holds it.
 *
 * One rule for every source. A mapping that names no path means the
 * conventional position, `contracts/<id>.md`, whether the source is this
 * repository or a repository being fetched from — which is what lets the
 * derivation that writes these lines look in one place rather than in one
 * place per kind of source.
 */
export function originPathOf(
  id: string,
  origin: ContractOrigin | undefined,
): string {
  return origin?.path ?? contractPath(id);
}

/**
 * The declaration a text spells out, or a refusal naming what it holds instead.
 *
 * Pure: the file system is the caller's business. What a declaration means is
 * decided here, where a test can state a document and the mapping it produces
 * side by side.
 */
export function parseDeclaration(text: string): Declaration {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (cause) {
    throw new ConfigError(
      `${DECLARATION_FILE}: not readable YAML: ${describeCause(cause)}`,
    );
  }
  if (document === null || document === undefined) return emptyDeclaration();
  const root = requireMapping(document, "the document");
  const sources = readSourceRecords(root["sources"]);
  return {
    sources,
    contracts: readContractOrigins(root["contracts"], sources),
  };
}

/**
 * The declaration the tree holds, or an empty one where it holds none.
 *
 * A tree with no declaration file is every repository that has never fetched
 * anything, so its absence is an answer rather than a refusal: no source is
 * registered and every contract is where it has always been. The path is
 * guarded before it is opened for the reason every other read here is — a link
 * standing at it would have the run read a table from outside the tree.
 */
export async function readDeclaration(root: string): Promise<Declaration> {
  await assertPlainChain(root, DECLARATION_FILE);
  if (!(await isRegularFileOrAbsent(root, DECLARATION_FILE))) {
    return emptyDeclaration();
  }
  return parseDeclaration(
    await readTextFile(`${root}/${DECLARATION_FILE}`, DECLARATION_FILE),
  );
}

/** A declaration registering nothing and mapping nothing. */
export function emptyDeclaration(): Declaration {
  return { sources: emptyRecord(), contracts: emptyRecord() };
}

function readSourceRecords(value: unknown): Record<string, SourceRecord> {
  const sources: Record<string, SourceRecord> = emptyRecord();
  if (value === undefined || value === null) return sources;
  const entries = requireMapping(value, "sources");
  for (const name of Object.keys(entries)) {
    assertSourceName(name);
    const entry = requireMapping(entries[name], `sources.${name}`);
    sources[name] = {
      repository: requireForm(
        entry["repository"],
        REPOSITORY_FORM,
        `sources.${name}.repository`,
        "an owner/repo pair",
      ),
      ref: requireRef(entry["ref"], `sources.${name}.ref`),
    };
  }
  return sources;
}

/**
 * The contract mappings, each judged against the sources the same document
 * registers.
 *
 * A mapping to a name nothing registers is refused rather than carried. There
 * is no reading of it that helps: taken as remote it sends the fetch at a
 * repository the tree never named, and taken as local it reports the contract
 * as a closure gap whose cause is nowhere in the message.
 */
function readContractOrigins(
  value: unknown,
  sources: Record<string, SourceRecord>,
): Record<string, ContractOrigin> {
  const contracts: Record<string, ContractOrigin> = emptyRecord();
  if (value === undefined || value === null) return contracts;
  const entries = requireMapping(value, "contracts");
  for (const id of Object.keys(entries)) {
    assertValidContractId(id, `${DECLARATION_FILE}: contracts`);
    const entry = requireMapping(entries[id], `contracts.${id}`);
    const source = requireText(entry["source"], `contracts.${id}.source`);
    if (source !== LOCAL_SOURCE && !(source in sources)) {
      throw new ConfigError(
        `${DECLARATION_FILE}: contracts.${id} names the source ${JSON.stringify(
          source,
        )}, which no sources entry registers`,
      );
    }
    const origin: ContractOrigin = { source };
    if (entry["path"] !== undefined) {
      origin.path = readCanonicalPath(
        entry["path"],
        id,
        source === LOCAL_SOURCE,
      );
    }
    contracts[id] = origin;
  }
  return contracts;
}

/**
 * Refuses a source name that could not stand alone as a directory, and the one
 * name that already means something else.
 *
 * The name is a path segment under the cache and a key in the lock, so it is
 * held to the shape a contract id is held to and for the same reason.
 *
 * Both refusals live here rather than one here and one in the schema, because
 * the schema is read from a file that has already been written: a command
 * asking whether a name is usable before it writes would get "yes" for the
 * reserved one and land an entry every later run stops on. One validator is
 * what keeps the answer the same on both sides of the write.
 */
export function assertSourceName(name: string): void {
  if (name === LOCAL_SOURCE) {
    throw new ConfigError(
      `${DECLARATION_FILE}: ${LOCAL_SOURCE} is reserved for this ` +
        `repository's own contracts and cannot name a source`,
    );
  }
  if (
    name.length > NAME_LIMIT ||
    name.includes("..") ||
    !SOURCE_NAME_FORM.test(name)
  ) {
    throw new ConfigError(
      `${DECLARATION_FILE}: not a usable source name: ${JSON.stringify(name)}`,
    );
  }
}

/** Refuses a repository written as anything but an owner/repo pair. */
export function assertRepository(repository: string): void {
  requireForm(
    repository,
    REPOSITORY_FORM,
    "the repository to add",
    "an owner/repo pair",
  );
}

/**
 * Refuses a ref that could name something other than the commit it appears to.
 *
 * The double dot and the empty segment are refused by name rather than by the
 * pattern: both are spellings the pattern alone lets through in the middle of
 * a value, and both are how a path or a URL is walked out of.
 */
function requireRef(value: unknown, path: string): string {
  const ref = requireForm(value, REF_FORM, path, "a branch, tag or commit SHA");
  if (ref.includes("..") || ref.includes("//")) {
    throw new ConfigError(
      `${DECLARATION_FILE}: ${path} must be a branch, tag or commit SHA, ` +
        `found ${JSON.stringify(ref)}`,
    );
  }
  return ref;
}

/**
 * True for a path that stays inside the tree it is read against: no empty
 * segment, no `.`, no `..`, nothing that reads as absolute, no backslash.
 *
 * One rule, wherever the path came from. A path is a line in this table or an
 * entry in a listing a host answered with, and both are joined onto a
 * directory this tool then reads from and writes into — so the answer to
 * "does this stay inside" has to be the same on both sides. Held as two
 * checks, one per module, the two drifted: the table refused a `..` while a
 * listing carrying one wrote a fetched file past the root of the tree the run
 * was pointed at.
 *
 * A backslash is refused although a POSIX file name may hold one, because the
 * same value is joined by a runtime that may read it as a separator, and a
 * shape meaning one thing per platform is not one this can vouch for.
 */
export function isTreeRelativePath(path: string): boolean {
  return (
    !path.includes("\\") &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function requireForm(
  value: unknown,
  form: RegExp,
  path: string,
  wanted: string,
): string {
  const text = requireText(value, path);
  if (!form.test(text)) {
    throw new ConfigError(
      `${DECLARATION_FILE}: ${path} must be ${wanted}, found ${JSON.stringify(
        text,
      )}`,
    );
  }
  return text;
}

/**
 * The path a mapping names for a canonical text, checked as a path inside the
 * tree it will be read against.
 *
 * The same shape rules hold whichever source the mapping names: a remote path
 * is joined onto a cache directory and onto a raw content URL, so a value that
 * walks upward escapes just as surely there as here.
 *
 * The two placement rules are local only, because they are about this
 * repository's own layout. A canonical text under skills/ would make one
 * skill's file the authority over another skill's copy — the implicit
 * dependency between skills that vendoring exists to remove — and one inside
 * the tool's own directory would make a fetched, throwaway file the authority
 * over what the tree distributes.
 */
function readCanonicalPath(
  value: unknown,
  id: string,
  isLocal: boolean,
): string {
  const path = requireText(value, `contracts.${id}.path`);
  const segments = path.split("/");
  if (!isTreeRelativePath(path)) {
    throw new ConfigError(
      `${DECLARATION_FILE}: contracts.${id}.path must be a path inside the ` +
        `tree it is read against, found ${JSON.stringify(path)}`,
    );
  }
  if (isLocal && (segments[0] === SKILLS_DIR || segments[0] === TOOL_DIR)) {
    throw new ConfigError(
      `${DECLARATION_FILE}: contracts.${id}.path points into ` +
        `${segments[0]}/, which holds copies rather than canonical text: ` +
        JSON.stringify(path),
    );
  }
  return path;
}

function requireMapping(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `${DECLARATION_FILE}: ${path} must be a mapping, found ${JSON.stringify(
        value,
      )}`,
    );
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(
      `${DECLARATION_FILE}: ${path} must be text, found ${JSON.stringify(
        value,
      )}`,
    );
  }
  return value;
}

// The writing half. Every change the tool makes to this file is a line
// inserted or a line taken out, never a re-rendering of the parsed document.
// Rendered whole, a run would delete the comments that record why a hand-
// written line is there — which is the only information in the file the tool
// cannot reconstruct.

const BLOCK_INDENT = "  ";
const ENTRY_INDENT = "    ";

/**
 * The text with `id` mapped to `source`, inserted at the end of the contracts
 * block.
 *
 * Appended rather than sorted into place. The order of this table is the
 * order a person chose, and a run that re-sorted it would put a diff nobody
 * asked for beside the one line it actually added.
 */
export function withContractMapping(
  text: string,
  id: string,
  source: string,
): string {
  return withEntry(text, "contracts", id, [`${ENTRY_INDENT}source: ${source}`]);
}

/**
 * The text with `name` registered as a source, inserted at the end of the
 * sources block.
 */
export function withSourceRegistration(
  text: string,
  name: string,
  record: SourceRecord,
): string {
  return withEntry(text, "sources", name, [
    `${ENTRY_INDENT}repository: ${record.repository}`,
    `${ENTRY_INDENT}ref: ${record.ref}`,
  ]);
}

/**
 * The text with `id` no longer mapped: the entry line and the lines indented
 * under it, and nothing else.
 *
 * A comment standing above the entry is left where it is. Whether it belonged
 * to the entry or introduced what follows it is a question only its author can
 * answer, and a scribe that guessed wrong would delete the record of a
 * decision while reporting that it pruned a mapping.
 */
export function withoutContractMapping(text: string, id: string): string {
  const { lines, ending } = documentLines(text);
  const opening = blockOpeningOf(lines, "contracts");
  if (opening === -1) return text;
  // The search stops where the block does. A source may be named after the
  // contract it holds, and a search that ran on would take that registration
  // out while the mapping it was asked to prune stayed where it was.
  const closing = blockEndOf(lines, opening);
  const entry = lines.findIndex(
    (line, index) =>
      index > opening && index < closing && isEntryOpening(line, id),
  );
  if (entry === -1) return text;
  let end = entry + 1;
  while (end < closing && lines[end].startsWith(ENTRY_INDENT)) end++;
  return [...lines.slice(0, entry), ...lines.slice(end), ""].join(ending);
}

/**
 * The document as lines, with the ending its lines are written with.
 *
 * The ending is carried rather than settled on. The scribe adds lines to a
 * file an editor keeps: lines of its own ending appended to a document written
 * with the other leave a file that still parses and no longer has one line
 * ending, and the next save of it rewrites every line — a whole-file diff
 * around the one line a run added, which is the same cost as re-rendering the
 * document.
 *
 * A document holding both endings is read as the one that is not bare, since
 * that is the ending something in the person's toolchain writes.
 */
function documentLines(text: string): { lines: string[]; ending: string } {
  return {
    lines: text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/),
    ending: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

/** True for the line that opens an entry of this name inside a block. */
function isEntryOpening(line: string, name: string): boolean {
  return new RegExp(
    `^${BLOCK_INDENT}${name.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}:\\s*(#.*)?$`,
  ).test(line);
}

/**
 * The text with an entry inserted at the end of the named top-level block,
 * creating the block where the document has none.
 */
function withEntry(
  text: string,
  block: string,
  name: string,
  body: string[],
): string {
  const { lines, ending } = documentLines(text);
  const entry = [`${BLOCK_INDENT}${name}:`, ...body];
  const opening = blockOpeningOf(lines, block);
  if (opening === -1) {
    // A blank line before a block the document did not have yet, unless the
    // document is empty or already ends in one: the file is read by people,
    // and two blocks running into each other read as one.
    const separator = lines.length > 0 && lines.at(-1) !== "" ? [""] : [];
    return [...lines, ...separator, `${block}:`, ...entry, ""].join(ending);
  }
  const inserted = insertionPointOf(lines, opening);
  return [
    ...lines.slice(0, inserted),
    ...entry,
    ...lines.slice(inserted),
    "",
  ].join(ending);
}

/** True for the line that opens a top-level block of this name. */
function isBlockOpening(line: string, block: string): boolean {
  return new RegExp(`^${block}:\\s*(#.*)?$`).test(line);
}

/** True for a top-level line that opens a key of this name, in any shape. */
function isBlockKey(line: string, block: string): boolean {
  return new RegExp(`^${block}:(\\s|$)`).test(line);
}

/**
 * Where the named block opens, -1 where the document holds no such key, and a
 * refusal where it holds one this scribe cannot edit.
 *
 * `contracts: {}` is a legal way to write the block, and a scribe that inserts
 * lines has nowhere to put one beneath it. Read as "the document has no such
 * block", the run opens a second one and leaves a document carrying the key
 * twice — which is exactly what this module's own reader refuses, so the file
 * a run had just written would stop every run after it.
 *
 * Rewriting the line into block form is the other way out, and it is refused
 * for what it costs: the flow form is a person's line, and a non-empty one
 * cannot be turned into a block without re-rendering the entries it holds —
 * the whole-document rewrite this half of the module exists to avoid.
 */
function blockOpeningOf(lines: string[], block: string): number {
  const opening = lines.findIndex((line) => isBlockOpening(line, block));
  if (opening !== -1) return opening;
  if (!lines.some((line) => isBlockKey(line, block))) return -1;
  throw new ConfigError(
    `${DECLARATION_FILE}: the ${block} block is written on one line, which ` +
      `leaves nowhere to add an entry under it; write ${block}: on a line of ` +
      `its own with each entry indented beneath it`,
  );
}

/**
 * The line the block ends before: the next top-level line, or the end.
 *
 * A comment is not a top-level line, wherever it starts. YAML gives a comment
 * no indentation to read, so one written at the left margin between two
 * entries stands inside the block as surely as an indented one — and read as
 * the end of it, every entry below stood outside the scribe's reach: the prune
 * left the line where it was and the insertion landed in the middle of the
 * table.
 */
function blockEndOf(lines: string[], opening: number): number {
  for (let index = opening + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trimStart().startsWith("#")) continue;
    if (line !== "" && !line.startsWith(" ")) return index;
  }
  return lines.length;
}

/**
 * Where a new entry goes: directly after the last line that belongs to an
 * entry of the block.
 *
 * Trailing blank lines and comments are left below the insertion rather than
 * above it. A comment written under the last entry is as likely to introduce
 * what comes next as to belong to what came before, and a blank line is a
 * separator a person put there — pushing both down keeps the file reading the
 * way it was written.
 */
function insertionPointOf(lines: string[], opening: number): number {
  const closing = blockEndOf(lines, opening);
  let point = opening + 1;
  for (let index = opening + 1; index < closing; index++) {
    const line = lines[index];
    if (line !== "" && !line.trimStart().startsWith("#")) point = index + 1;
  }
  return point;
}
