// vendor.ts — vendors shared reference documents into a skill repository.
//
// This file is the whole distributed artifact. Consumers sync it at a fixed
// sha256 and run it with `deno run --allow-read --allow-write vendor.ts <cmd>`,
// which means the pinned hash has to cover every behaviour the tool has. It
// therefore imports nothing: an import would place code, and a network
// dependency, outside the hash a consumer verified.

const DIGEST_PREFIX = "sha256:";
const CONTRACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const CONTRACT_ID_LIMIT = 64;
const FRONTMATTER_DELIMITER = "---";
const BYTECODE_CACHE_DIR = "__pycache__";

/** A misconfiguration or misuse: the run stops and writes nothing. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// --- text canonicalization -------------------------------------------------

interface Document {
  frontmatter: string[];
  body: string;
}

/**
 * Splits a document into its frontmatter lines and its body. Blank lines
 * directly after the closing delimiter belong to the separator, not the body.
 *
 * An opening `---` with no closing `---` is an error rather than a document
 * that happens to have no frontmatter: reading it as all-body would silently
 * drop every declaration the unterminated block holds, and a pin that vanishes
 * quietly is the worst failure this tool can have.
 */
function splitDocument(text: string, site?: string): Document {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    return { frontmatter: [], body: normalized };
  }
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] !== FRONTMATTER_DELIMITER) continue;
    let start = index + 1;
    while (start < lines.length && lines[start] === "") start++;
    return {
      frontmatter: lines.slice(1, index),
      body: lines.slice(start).join("\n"),
    };
  }
  throw new ConfigError(
    `${
      site ?? "document"
    }: frontmatter opens with '---' but the closing '---' line is missing`,
  );
}

/** Frontmatter stripped, LF endings, exactly one trailing newline. */
export function canonicalBody(text: string, site?: string): string {
  // Only line endings and the end of file are canonicalized. Whitespace at the
  // end of a line is content: in Markdown two trailing spaces are a hard line
  // break, so trimming per line would change what the document means.
  return splitDocument(text, site).body.replace(/\n+$/, "") + "\n";
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Digest of exactly these bytes, in `sha256:<hex>` form. */
export async function digestOfBytes(bytes: Uint8Array): Promise<string> {
  return DIGEST_PREFIX + await sha256Hex(bytes);
}

/** Digest of this text's UTF-8 bytes, with no canonicalization applied. */
export function digestOfText(text: string): Promise<string> {
  return digestOfBytes(new TextEncoder().encode(text));
}

/** Digest of a contract document's canonical body. */
export function contractDigest(text: string, site?: string): Promise<string> {
  return digestOfText(canonicalBody(text, site));
}

/** True when the id is safe to place in a path: an allowlist with no traversal. */
export function isValidContractId(id: string): boolean {
  // The pattern alone accepts `a..b`, because a dot is a legal character in the
  // middle of an id. The explicit `..` check is the part that rejects it, and
  // it rejects every embedded double dot rather than only `../`.
  return id.length <= CONTRACT_ID_LIMIT &&
    !id.includes("..") &&
    CONTRACT_ID_PATTERN.test(id);
}

export function assertValidContractId(id: string, site: string): void {
  if (!isValidContractId(id)) {
    throw new ConfigError(
      `${site}: not a usable contract id: ${JSON.stringify(id)}`,
    );
  }
}

// --- declaration parsing ---------------------------------------------------

// Declarations are read by a parser that accepts one restricted grammar rather
// than by a general YAML parser. A general parser is built to accept as much as
// it can, so every form this tool must refuse — a digest beside an id, a flow
// sequence, a duplicate key — would instead be quietly accepted and reinterpreted.
// Refusing loudly is only possible if the accepted shape is stated exactly.

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Drops a trailing comment. No value this grammar accepts can contain '#'. */
function withoutComment(text: string): string {
  if (text.trimStart().startsWith("#")) return "";
  const start = text.indexOf(" #");
  return start === -1 ? text : text.slice(0, start);
}

function isIgnorable(line: string): boolean {
  return withoutComment(line).trim() === "";
}

/**
 * The contract ids a SKILL.md declares, in declaration order.
 *
 * The accepted shape is a block sequence of bare ids under `metadata.contracts`.
 * Anything else stops the run: a declaration this tool cannot read is never
 * treated as an absence of declarations, because that would silently unpin a
 * skill that believes it is pinned.
 */
export function parseContractDeclarations(
  text: string,
  site: string,
): string[] {
  const frontmatter = splitDocument(text, site).frontmatter;
  const metadataAt = frontmatter.findIndex(
    (line) => indentOf(line) === 0 && /^metadata:(\s|$)/.test(line),
  );
  if (metadataAt === -1) return [];
  requireNoInlineValue(frontmatter[metadataAt], "metadata", "metadata", site);

  const block: string[] = [];
  for (let index = metadataAt + 1; index < frontmatter.length; index++) {
    const line = frontmatter[index];
    if (isIgnorable(line)) continue;
    if (indentOf(line) === 0) break;
    block.push(line);
  }
  if (block.length === 0) return [];

  const childIndent = indentOf(block[0]);
  const contractsAt = block.findIndex(
    (line) =>
      indentOf(line) === childIndent &&
      /^contracts:(\s|$)/.test(line.trimStart()),
  );
  if (contractsAt === -1) return [];
  requireNoInlineValue(
    block[contractsAt],
    "contracts",
    "metadata.contracts",
    site,
  );

  return readSequence(block.slice(contractsAt + 1), childIndent, site);
}

/**
 * Refuses a key that carries its value on the same line. That shape is a flow
 * sequence or a flow mapping, and this grammar accepts only block form.
 */
function requireNoInlineValue(
  line: string,
  keyToken: string,
  label: string,
  site: string,
): void {
  const value = withoutComment(line).trimStart().slice(keyToken.length + 1);
  if (value.trim() !== "") {
    throw new ConfigError(
      `${site}: ${label} must be written in block form, not ${
        JSON.stringify(value.trim())
      }`,
    );
  }
}

function readSequence(
  lines: string[],
  keyIndent: number,
  site: string,
): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    if (indentOf(line) <= keyIndent) {
      if (line.trimStart().startsWith("- ")) {
        throw new ConfigError(
          `${site}: metadata.contracts entries must be indented deeper than the contracts key`,
        );
      }
      break;
    }
    const entry = withoutComment(line).trimStart();
    const item = /^-\s+(.*)$/.exec(entry);
    if (item === null) {
      throw new ConfigError(
        `${site}: unreadable metadata.contracts entry: ${
          JSON.stringify(entry)
        }`,
      );
    }
    const id = item[1].trim();
    if (id.includes(":")) {
      // The pin belongs to the lock, not to the skill. A digest written here
      // would put the skill's SKILL.md into the diff of every contract update,
      // which is exactly what declaring by id alone exists to prevent.
      throw new ConfigError(
        `${site}: metadata.contracts entries name a contract id and nothing else; ` +
          `digests live in the lock: ${JSON.stringify(id)}`,
      );
    }
    assertValidContractId(id, site);
    if (ids.includes(id)) {
      throw new ConfigError(`${site}: contract declared more than once: ${id}`);
    }
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new ConfigError(
      `${site}: metadata.contracts is present but declares no contract`,
    );
  }
  return ids;
}

// --- conformance framing ---------------------------------------------------

export interface ConformanceEntry {
  path: string;
  content: Uint8Array;
}

/**
 * Digest over a conformance tree. Files are fed in path order, each framed as
 * `relative-posix-path NUL byte-length NUL content`, so no arrangement of file
 * names and contents can be confused with another one.
 *
 * Content is hashed as raw bytes and never canonicalized: conformance tests run
 * byte-exactly, so a line ending is part of what was pinned.
 */
export async function conformanceDigestOfEntries(
  entries: ConformanceEntry[],
): Promise<string> {
  const ordered = [...entries].sort((a, b) => compareStrings(a.path, b.path));
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const entry of ordered) {
    chunks.push(encoder.encode(`${entry.path}\0${entry.content.length}\0`));
    chunks.push(entry.content);
  }
  return await digestOfBytes(concatBytes(chunks));
}

/** Reads a conformance tree, or nothing at all when the directory is absent. */
export async function collectConformanceEntries(
  dir: string,
): Promise<ConformanceEntry[]> {
  if (!await isDirectory(dir)) return [];
  const entries: ConformanceEntry[] = [];
  for (const relative of await walkFiles(dir)) {
    // Running the tests must not change what the tests digest to, so compiled
    // bytecode is excluded wherever it appears in the tree.
    if (relative.split("/").includes(BYTECODE_CACHE_DIR)) continue;
    entries.push({
      path: relative,
      content: await Deno.readFile(`${dir}/${relative}`),
    });
  }
  return entries;
}

/**
 * The conformance digest pinned for one contract, or null when the contract
 * ships no conformance tests.
 *
 * A directory holding nothing after the bytecode exclusion counts as absent,
 * the same as no directory at all: git cannot store an empty directory, so a
 * fresh checkout drops it and any other reading would report a false mismatch.
 */
export async function conformanceDigest(
  root: string,
  id: string,
): Promise<string | null> {
  const entries = await collectConformanceEntries(
    `${root}/contracts/${id}/conformance`,
  );
  if (entries.length === 0) return null;
  return await conformanceDigestOfEntries(entries);
}

// --- file system boundary --------------------------------------------------

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** True for a real directory; a symlink in its place is refused outright. */
async function isDirectory(path: string): Promise<boolean> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw new ConfigError(`cannot read ${path}: ${describeCause(cause)}`);
  }
  if (info.isSymlink) {
    throw new ConfigError(`symlink is not allowed here: ${path}`);
  }
  return info.isDirectory;
}

/**
 * Every file under `dir`, as relative posix paths in sorted order.
 *
 * A symlink is refused rather than followed. Following one would let a link
 * planted inside the tree read, or be overwritten onto, a file outside it —
 * and generated vendoring state has no legitimate reason to contain links, so
 * refusing costs nothing and closes the escape structurally.
 */
export async function walkFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  await walkInto(dir, "", found);
  return found.sort(compareStrings);
}

async function walkInto(
  dir: string,
  prefix: string,
  into: string[],
): Promise<void> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch (cause) {
    throw new ConfigError(`cannot read ${dir}: ${describeCause(cause)}`);
  }
  entries.sort((a, b) => compareStrings(a.name, b.name));
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymlink) {
      throw new ConfigError(
        `symlink is not allowed inside a scanned tree: ${path}`,
      );
    }
    if (entry.isDirectory) await walkInto(path, relative, into);
    else into.push(relative);
  }
}

/**
 * Writes `content` at `path` through a temporary file in the same directory.
 *
 * The temporary file is a sibling rather than an OS temporary: a rename is only
 * atomic within one file system, and the OS temporary directory is frequently
 * on another one.
 */
export async function atomicWriteFile(
  path: string,
  content: Uint8Array,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await refuseSymlink(temporary);
  await refuseSymlink(path);
  try {
    await Deno.writeFile(temporary, content);
    await Deno.rename(temporary, path);
  } catch (cause) {
    await Deno.remove(temporary).catch(() => {});
    throw new ConfigError(`cannot write ${path}: ${describeCause(cause)}`);
  }
}

async function refuseSymlink(path: string): Promise<void> {
  try {
    const info = await Deno.lstat(path);
    if (info.isSymlink) {
      throw new ConfigError(`refusing to write through a symlink: ${path}`);
    }
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    if (cause instanceof Deno.errors.NotFound) return;
    throw new ConfigError(`cannot inspect ${path}: ${describeCause(cause)}`);
  }
}

/**
 * Decodes bytes that must be UTF-8. Input this tool digests or parses is
 * refused when it is not, rather than being repaired into something that would
 * digest differently from what the author wrote.
 */
export function decodeUtf8(bytes: Uint8Array, site: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(`${site}: not valid UTF-8`);
  }
}

/** Reads a file that must be UTF-8 text. */
export async function readTextFile(
  path: string,
  site: string,
): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch (cause) {
    throw new ConfigError(`cannot read ${site}: ${describeCause(cause)}`);
  }
  return decodeUtf8(bytes, site);
}
