import { load as parseYaml } from "js-yaml";
import { ConfigError, describeCause } from "../errors.ts";
import { assertValidContractId } from "./digest.ts";
import { emptyRecord } from "../records.ts";
import { SKILLS_DIR } from "./declaration.ts";
import { MARKER_FILE } from "./raw.ts";
import { readDistributionIgnore } from "./distribution-ignore.ts";
import { pathsOverlap } from "./placement-ownership.ts";
import { assertUsableSourceName, classifyRepository } from "./repository.ts";
import {
  type ContractOrigin,
  type Declaration,
  DECLARATION_FILE,
  LOCAL_SOURCE,
  type RawKind,
  type RawMapping,
  readDeclarationText,
  type SourceRecord,
  TOOL_DIR,
  VENDOR_SUBPATH,
} from "./sources.ts";

const REF_FORM = /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/;

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
    ignore: readDistributionIgnore(
      root["ignore"],
      `${DECLARATION_FILE}: ignore`,
    ),
  };
}

/** A declaration registering nothing and mapping nothing. */
export function emptyDeclaration(): Declaration {
  return { sources: emptyRecord(), contracts: emptyRecord(), ignore: [] };
}

export async function readDeclaration(root: string): Promise<Declaration> {
  const text = await readDeclarationText(root);
  return text === null ? emptyDeclaration() : parseDeclaration(text);
}

function readSourceRecords(value: unknown): Record<string, SourceRecord> {
  const sources: Record<string, SourceRecord> = emptyRecord();
  if (value === undefined || value === null) return sources;
  const entries = requireMapping(value, "sources");
  for (const name of Object.keys(entries)) {
    assertSourceName(name);
    const entry = requireMapping(entries[name], `sources.${name}`);
    sources[name] = {
      repository: requireRepository(
        entry["repository"],
        `sources.${name}.repository`,
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
    const origin: ContractOrigin = {
      source,
      ignore: readDistributionIgnore(
        entry["ignore"],
        `${DECLARATION_FILE}: contracts.${id}.ignore`,
      ),
    };
    if (entry["files"] !== undefined) {
      if (entry["path"] !== undefined) {
        throw new ConfigError(
          `${DECLARATION_FILE}: contracts.${id} carries both files and path; ` +
            `the src paths of a raw-byte contract are the keys of files`,
        );
      }
      origin.files = readRawMappings(
        entry["files"],
        id,
        source === LOCAL_SOURCE,
      );
    } else if (entry["path"] !== undefined) {
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
  assertUsableSourceName(name, `${DECLARATION_FILE}: source name`);
}

/** Refuses a repository outside the transport allowlist. */
export function assertRepository(repository: string): void {
  classifyRepository(repository);
}

function requireRepository(value: unknown, path: string): string {
  const repository = requireText(value, path);
  try {
    classifyRepository(repository);
  } catch (cause) {
    if (cause instanceof ConfigError) {
      throw new ConfigError(`${DECLARATION_FILE}: ${path}: ${cause.message}`);
    }
    throw cause;
  }
  return repository;
}

/**
 * True for a ref that names the commit it appears to, and nothing else.
 *
 * The double dot and the empty segment are refused by name rather than by the
 * pattern: both are spellings the pattern alone lets through in the middle of
 * a value, and both are how a path or a URL is walked out of.
 *
 * Asked as a question rather than kept inside the schema's own refusal,
 * because the same question is asked at three places and the answer has to be
 * the same at all three: of a ref read out of the table, of the branch a
 * repository answers with before it is written into the table, and of the
 * scalar the scribe is about to write. Held only at the reading end, a value
 * arriving from a source could land in the file in a shape the next run
 * refuses — or, carrying a line break, in a shape that reads as more of the
 * document than the one line it was meant to be.
 */
export function isUsableRef(value: string): boolean {
  return REF_FORM.test(value) && !value.includes("..") && !value.includes("//");
}

/** Refuses a ref that could name something other than the commit it appears to. */
function requireRef(value: unknown, path: string): string {
  const ref = requireText(value, path);
  if (!isUsableRef(ref)) {
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

/**
 * The src → dest pairs a raw-byte row declares, each side judged as a path.
 *
 * The trailing slash is a kind marker, not a path character: it is read off
 * both sides, must agree between them, and the path left behind is held to
 * the same shape every other path in this table is. A dest is judged against
 * the skill it lands in — inside it, never its SKILL.md, never the directory
 * the document copies are swept from.
 */
function readRawMappings(
  value: unknown,
  id: string,
  isLocal: boolean,
): RawMapping[] {
  const entries = requireMapping(value, `contracts.${id}.files`);
  const mappings: RawMapping[] = [];
  for (const key of Object.keys(entries)) {
    const dest = requireText(entries[key], `contracts.${id}.files.${key}`);
    const srcKind = kindOf(key);
    const destKind = kindOf(dest);
    if (srcKind !== destKind) {
      throw new ConfigError(
        `${DECLARATION_FILE}: contracts.${id}.files maps ${JSON.stringify(
          key,
        )} to ${JSON.stringify(dest)}, a ${srcKind} to a ${destKind}; ` +
          `both sides must end in a slash, or neither`,
      );
    }
    mappings.push({
      src: readCanonicalPath(withoutKind(key), id, isLocal),
      dest: readDestPath(withoutKind(dest), id),
      kind: srcKind,
    });
  }
  if (mappings.length === 0) {
    throw new ConfigError(
      `${DECLARATION_FILE}: contracts.${id}.files maps nothing; a raw-byte ` +
        `contract distributes at least one file or directory`,
    );
  }
  return mappings;
}

function kindOf(path: string): RawKind {
  return path.endsWith("/") ? "directory" : "file";
}

function withoutKind(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * A dest, judged as a path inside the skill it lands in.
 *
 * `SKILL.md` is the declaration itself. `references/vendor/` is the one
 * directory the document-contract sweep owns whole, so nothing raw may stand
 * at it, under it or over it — two ownership rules over one path would each
 * delete what the other wrote.
 */
function readDestPath(dest: string, id: string): string {
  if (!isTreeRelativePath(dest)) {
    throw new ConfigError(
      `${DECLARATION_FILE}: contracts.${id}.files names a dest that does ` +
        `not stay inside the skill it lands in: ${JSON.stringify(dest)}`,
    );
  }
  const reserved = reservedDestRefusal(dest);
  if (reserved !== null) {
    throw new ConfigError(
      `${DECLARATION_FILE}: contracts.${id}.files names ${reserved}`,
    );
  }
  return dest;
}

/**
 * Why a dest may not stand at a reserved position, or null where it may. One
 * judgment for the table and the lock alike: the lock's dests are where the
 * sweep deletes, so a position the table may not name is one the lock may
 * not remember either.
 */
export function reservedDestRefusal(dest: string): string | null {
  if (dest === "SKILL.md") return "SKILL.md as a dest";
  if (dest === MARKER_FILE || dest.endsWith(`/${MARKER_FILE}`)) {
    return (
      `${MARKER_FILE} as a dest: ${JSON.stringify(dest)} is the name of the ` +
      `marker gen writes, and a file by that name is left out of every ` +
      `digest, so it could never verify`
    );
  }
  if (pathsOverlap(dest, VENDOR_SUBPATH)) {
    return (
      `a dest at, under or over ${VENDOR_SUBPATH}/, which the document ` +
      `copies are swept from: ${JSON.stringify(dest)}`
    );
  }
  return null;
}

/** True when two dests are the same path or one lies under the other. */
export function destsCollide(a: string, b: string): boolean {
  return pathsOverlap(a, b);
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
