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

// --- tree layout -----------------------------------------------------------

const MANIFEST_FILE = "vendor-manifest.json";
const CONTRACTS_DIR = "contracts";
const SKILLS_DIR = "skills";
const VENDOR_SUBPATH = "references/vendor";
const SKILL_FILE = "SKILL.md";
const DIGEST_FORM = /^sha256:[0-9a-f]{64}$/;

const GENERATOR = {
  name: "vendor.ts",
  version: "1.0.0",
  source: "https://github.com/ba0918/agentic-skill-shared-reference-vendoring",
} as const;

function contractPath(id: string): string {
  return `${CONTRACTS_DIR}/${id}.md`;
}

function vendorDirOf(skill: string): string {
  return `${SKILLS_DIR}/${skill}/${VENDOR_SUBPATH}`;
}

function skillFileOf(skill: string): string {
  return `${SKILLS_DIR}/${skill}/${SKILL_FILE}`;
}

/**
 * Refuses a symlink anywhere along a path inside the tree.
 *
 * Checking only the last component would not be enough: a link at any level
 * makes every path below it resolve outside the tree, so a directory created
 * under it would be created somewhere the run was never pointed at.
 */
async function assertPlainChain(root: string, relative: string): Promise<void> {
  let path = root;
  for (const part of relative.split("/")) {
    path = `${path}/${part}`;
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return;
      throw new ConfigError(
        `cannot inspect ${relative}: ${describeCause(cause)}`,
      );
    }
    if (info.isSymlink) {
      throw new ConfigError(
        `symlink is not allowed inside the tree: ${relative}`,
      );
    }
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw new ConfigError(`cannot inspect ${path}: ${describeCause(cause)}`);
  }
  if (info.isSymlink) {
    throw new ConfigError(`symlink is not allowed inside the tree: ${path}`);
  }
  return info.isFile;
}

// --- manifest --------------------------------------------------------------

export interface Resolution {
  digest: string;
  conformance?: string;
  version?: string;
}

export type Resolutions = Record<string, Resolution>;
export type Dependencies = Record<string, string[]>;

/**
 * The manifest's canonical rendering: keys sorted at every level, two-space
 * indentation, one trailing newline, and no escaping of non-ASCII text.
 *
 * Verify compares the manifest byte for byte, so a canonical rendering is what
 * makes "the manifest is up to date" a decidable question rather than a
 * question about JSON formatting.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(withSortedKeys(value), null, 2) + "\n";
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareStrings)) {
    sorted[key] = withSortedKeys(source[key]);
  }
  return sorted;
}

export function buildManifest(
  dependencies: Dependencies,
  resolutions: Resolutions,
): unknown {
  const contracts: Record<string, { source: string }> = {};
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    contracts[id] = { source: contractPath(id) };
  }
  // No wall-clock value is recorded anywhere in here. Reproducibility is the
  // reason this file exists, and a timestamp would make every regeneration a
  // change.
  return {
    lock: { dependencies, resolutions },
    provenance: { contracts, generator: { ...GENERATOR } },
  };
}

/** The resolutions currently recorded, or none when there is no manifest yet. */
export async function readResolutions(root: string): Promise<Resolutions> {
  await assertPlainChain(root, MANIFEST_FILE);
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(`${root}/${MANIFEST_FILE}`);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return {};
    throw new ConfigError(
      `cannot read ${MANIFEST_FILE}: ${describeCause(cause)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, MANIFEST_FILE));
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `${MANIFEST_FILE}: not readable JSON: ${describeCause(cause)}`,
    );
  }
  return validateResolutions(parsed);
}

function validateResolutions(parsed: unknown): Resolutions {
  const lock = pickObject(pickObject(parsed, "")["lock"], "lock");
  const raw = lock["resolutions"];
  if (raw === undefined) return {};
  const entries = pickObject(raw, "lock.resolutions");
  const resolutions: Resolutions = {};
  for (const id of Object.keys(entries)) {
    assertValidContractId(id, `${MANIFEST_FILE}: lock.resolutions`);
    const entry = pickObject(entries[id], `lock.resolutions.${id}`);
    const resolution: Resolution = {
      digest: requireDigest(entry["digest"], `lock.resolutions.${id}.digest`),
    };
    if (entry["conformance"] !== undefined) {
      resolution.conformance = requireDigest(
        entry["conformance"],
        `lock.resolutions.${id}.conformance`,
      );
    }
    if (entry["version"] !== undefined) {
      if (typeof entry["version"] !== "string") {
        throw new ConfigError(
          `${MANIFEST_FILE}: lock.resolutions.${id}.version must be a string`,
        );
      }
      resolution.version = entry["version"];
    }
    resolutions[id] = resolution;
  }
  return resolutions;
}

function pickObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `${MANIFEST_FILE}: ${path || "document"} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !DIGEST_FORM.test(value)) {
    throw new ConfigError(
      `${MANIFEST_FILE}: ${path} must be a sha256 digest, found ${
        JSON.stringify(value)
      }`,
    );
  }
  return value;
}

// --- reading the tree ------------------------------------------------------

export interface SkillDeclaration {
  name: string;
  contracts: string[];
}

export interface CanonicalContract {
  digest: string;
  body: string;
  version?: string;
}

/** Every skill directly under skills/, with the contracts it declares. */
export async function readSkills(root: string): Promise<SkillDeclaration[]> {
  const skillsDir = `${root}/${SKILLS_DIR}`;
  if (!await isDirectory(skillsDir)) return [];
  const names: string[] = [];
  for await (const entry of Deno.readDir(skillsDir)) {
    if (entry.isSymlink) {
      throw new ConfigError(
        `symlink is not allowed inside the tree: ${SKILLS_DIR}/${entry.name}`,
      );
    }
    if (entry.isDirectory) names.push(entry.name);
  }
  names.sort(compareStrings);

  const skills: SkillDeclaration[] = [];
  for (const name of names) {
    const site = skillFileOf(name);
    // A directory with no SKILL.md declares nothing, but it is still listed:
    // otherwise a vendored copy left under it would be invisible to both the
    // check for unaccounted copies and the removal that clears them.
    const contracts = await isRegularFile(`${root}/${site}`)
      ? parseContractDeclarations(
        await readTextFile(`${root}/${site}`, site),
        site,
      )
      : [];
    skills.push({ name, contracts });
  }
  return skills;
}

/** The declared contract ids across all skills, without duplicates. */
export function declaredIds(skills: SkillDeclaration[]): string[] {
  const ids = new Set<string>();
  for (const skill of skills) for (const id of skill.contracts) ids.add(id);
  return [...ids].sort(compareStrings);
}

function dependentsOf(skills: SkillDeclaration[], id: string): string[] {
  return skills.filter((skill) => skill.contracts.includes(id)).map((skill) =>
    skill.name
  )
    .sort(compareStrings);
}

/**
 * The dependency half of the lock: a skill mapped to the contracts it declares.
 *
 * The ids are sorted rather than kept in declaration order. The lock is a
 * canonical form, duplicates are already refused, and so the order in which a
 * skill happens to list its contracts carries no meaning that a rewrite of the
 * lock should record.
 */
export function dependenciesOf(skills: SkillDeclaration[]): Dependencies {
  const dependencies: Dependencies = {};
  for (const skill of skills) {
    if (skill.contracts.length === 0) continue;
    dependencies[skill.name] = [...skill.contracts].sort(compareStrings);
  }
  return dependencies;
}

function frontmatterScalar(
  frontmatter: string[],
  key: string,
): string | undefined {
  const line = frontmatter.find(
    (candidate) =>
      indentOf(candidate) === 0 && candidate.startsWith(`${key}:`) &&
      /^[^:]+:(\s|$)/.test(candidate),
  );
  if (line === undefined) return undefined;
  const value = withoutComment(line).slice(key.length + 1).trim();
  if (value === "") return undefined;
  return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

/** Reads each contract's canonical text, or null where the file is absent. */
export async function readContracts(
  root: string,
  ids: string[],
): Promise<Map<string, CanonicalContract | null>> {
  const contracts = new Map<string, CanonicalContract | null>();
  for (const id of ids) {
    const site = contractPath(id);
    if (!await isRegularFile(`${root}/${site}`)) {
      contracts.set(id, null);
      continue;
    }
    const text = await readTextFile(`${root}/${site}`, site);
    const document = splitDocument(text, site);
    const body = canonicalBody(text, site);
    contracts.set(id, {
      digest: await digestOfText(body),
      body,
      version: frontmatterScalar(document.frontmatter, "version"),
    });
  }
  return contracts;
}

// --- vendored copies -------------------------------------------------------

/**
 * The bytes of a vendored copy: the three facts the specification fixes, then
 * the canonical body.
 *
 * No source path and no time of generation appear. A path would make the copy
 * depend on where it came from, and a timestamp would make two runs over
 * unchanged input produce different files.
 */
export function renderVendorFile(
  id: string,
  digest: string,
  body: string,
): string {
  return vendorHeader(id, digest) + body;
}

/** The fixed prefix of a vendored copy, rebuilt from an id and a pinned digest. */
export function vendorHeader(id: string, digest: string): string {
  return `<!-- DO NOT EDIT. Generated by ${GENERATOR.name}. -->\n` +
    `<!-- contract: ${id} -->\n` +
    `<!-- source-digest: ${digest} -->\n\n`;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

/** The names directly inside a skill's vendor directory. */
async function listVendorEntries(
  root: string,
  skill: string,
): Promise<string[]> {
  const relative = vendorDirOf(skill);
  await assertPlainChain(root, relative);
  const dir = `${root}/${relative}`;
  if (!await isDirectory(dir)) return [];
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isSymlink) {
      throw new ConfigError(
        `symlink is not allowed inside the tree: ${relative}/${entry.name}`,
      );
    }
    names.push(entry.name);
  }
  return names.sort(compareStrings);
}

// --- the write phase -------------------------------------------------------

interface WritePlan {
  files: { path: string; content: Uint8Array }[];
  manifest: { path: string; content: Uint8Array };
  removals: string[];
}

/**
 * Builds every byte the run will write before writing any of them, so that a
 * tree is never half-updated because of something the run could have known in
 * advance.
 */
async function planExpansion(
  root: string,
  skills: SkillDeclaration[],
  contracts: Map<string, CanonicalContract | null>,
  resolutions: Resolutions,
): Promise<WritePlan> {
  const encoder = new TextEncoder();
  const files: WritePlan["files"] = [];
  const removals: string[] = [];
  for (const skill of skills) {
    const expected = new Set<string>();
    for (const id of skill.contracts) {
      const contract = contracts.get(id);
      if (contract === null || contract === undefined) continue;
      expected.add(`${id}.md`);
      files.push({
        path: `${root}/${vendorDirOf(skill.name)}/${id}.md`,
        content: encoder.encode(
          renderVendorFile(id, contract.digest, contract.body),
        ),
      });
    }
    for (const name of await listVendorEntries(root, skill.name)) {
      if (!expected.has(name)) {
        removals.push(`${root}/${vendorDirOf(skill.name)}/${name}`);
      }
    }
  }
  return {
    files,
    manifest: {
      path: `${root}/${MANIFEST_FILE}`,
      content: encoder.encode(
        canonicalJson(buildManifest(dependenciesOf(skills), resolutions)),
      ),
    },
    removals,
  };
}

/**
 * Copies first, then the manifest, then the removals.
 *
 * A run stopped part way therefore never loses a file it had not yet replaced,
 * and the state it leaves is one verify reports as a violation rather than one
 * that looks finished.
 */
async function executePlan(plan: WritePlan): Promise<void> {
  for (const file of plan.files) {
    await ensureParentDirectory(file.path);
    await atomicWriteFile(file.path, file.content);
  }
  await atomicWriteFile(plan.manifest.path, plan.manifest.content);
  for (const path of plan.removals) {
    await Deno.remove(path, { recursive: true }).catch(() => {});
  }
}

async function ensureParentDirectory(path: string): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  try {
    await Deno.mkdir(parent, { recursive: true });
  } catch (cause) {
    throw new ConfigError(`cannot create ${parent}: ${describeCause(cause)}`);
  }
}

// --- acceptance checks -----------------------------------------------------

/**
 * The half of verification that compares canonical text against what was
 * accepted. gen runs exactly these checks and refuses to expand while any of
 * them holds, so no vendored copy can carry text nobody approved.
 */
function acceptanceViolations(
  skills: SkillDeclaration[],
  contracts: Map<string, CanonicalContract | null>,
  resolutions: Resolutions,
): string[] {
  const violations: string[] = [];
  for (const id of declaredIds(skills)) {
    const dependents = dependentsOf(skills, id).join(", ");
    const contract = contracts.get(id) ?? null;
    if (contract === null) {
      violations.push(
        `closure: ${id} is declared by ${dependents} but ${
          contractPath(id)
        } does not exist`,
      );
      continue;
    }
    const resolution = resolutions[id];
    if (resolution === undefined) {
      violations.push(
        `unresolved: ${id} has no entry in ${MANIFEST_FILE}; accept ${id} to record one`,
      );
      continue;
    }
    if (resolution.digest !== contract.digest) {
      violations.push(
        `unaccepted-drift: ${id} is resolved to ${resolution.digest} but ${
          contractPath(id)
        } is ${contract.digest}; accept ${id} to adopt the new text`,
      );
    }
  }
  return violations;
}

/**
 * Compares each vendored copy against the pin, never against the canonical
 * text.
 *
 * Comparing against the canonical text would leave this check undefined exactly
 * when it matters most: once a contract has been edited but not accepted, the
 * copies are still correct with respect to what was approved, and that is the
 * state continuous integration has to be able to judge.
 */
async function copyViolations(
  root: string,
  skills: SkillDeclaration[],
  resolutions: Resolutions,
): Promise<string[]> {
  const encoder = new TextEncoder();
  const violations: string[] = [];
  for (const skill of skills) {
    const dir = vendorDirOf(skill.name);
    const accountedFor = new Set(skill.contracts.map((id) => `${id}.md`));
    for (const id of [...skill.contracts].sort(compareStrings)) {
      const resolution = resolutions[id];
      if (resolution === undefined) continue;
      const site = `${dir}/${id}.md`;
      if (!await isRegularFile(`${root}/${site}`)) {
        violations.push(`drift: ${site} is missing`);
        continue;
      }
      const bytes = await Deno.readFile(`${root}/${site}`);
      const header = encoder.encode(vendorHeader(id, resolution.digest));
      // Compared as bytes and never decoded, so a corrupted copy is drift
      // rather than an error about the tool's own input.
      if (!startsWith(bytes, header)) {
        violations.push(
          `drift: ${site} does not carry the header generated for ${resolution.digest}`,
        );
        continue;
      }
      const body = await digestOfBytes(bytes.slice(header.length));
      if (body !== resolution.digest) {
        violations.push(
          `drift: ${site} holds text digesting to ${body}, the lock pins ${resolution.digest}`,
        );
      }
    }
    for (const name of await listVendorEntries(root, skill.name)) {
      if (!accountedFor.has(name)) {
        violations.push(`extra: ${dir}/${name} answers to no declaration`);
      }
    }
  }
  return violations;
}

/**
 * Compares the manifest against what the declarations and the recorded
 * resolutions render to.
 *
 * The resolutions are carried across unchanged rather than recomputed, so a
 * divergence already reported as unaccepted drift or a conformance mismatch is
 * not reported a second time here as a stale manifest.
 */
async function manifestViolations(
  root: string,
  skills: SkillDeclaration[],
  resolutions: Resolutions,
): Promise<string[]> {
  const path = `${root}/${MANIFEST_FILE}`;
  if (!await isRegularFile(path)) {
    return [`manifest: ${MANIFEST_FILE} is missing`];
  }
  const expected = canonicalJson(
    buildManifest(dependenciesOf(skills), resolutions),
  );
  const actual = decodeUtf8(await Deno.readFile(path), MANIFEST_FILE);
  if (actual === expected) return [];
  return [
    `manifest: ${MANIFEST_FILE} differs from what the declarations and the lock render to`,
  ];
}

/**
 * Compares each contract's conformance tree against the digest that was
 * accepted for it. The wording states the two values and does not claim which
 * of them moved: this tool cannot tell an edited test from a stale lock.
 */
async function conformanceViolations(
  root: string,
  resolutions: Resolutions,
): Promise<string[]> {
  const violations: string[] = [];
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    const current = await conformanceDigest(root, id);
    const locked = resolutions[id].conformance ?? null;
    if (current === locked) continue;
    violations.push(
      `conformance-mismatch: ${id} now has ${
        current ?? "no conformance tests"
      }` +
        `, the lock records ${locked ?? "none"}`,
    );
  }
  return violations;
}

// --- commands --------------------------------------------------------------

export type Sink = (line: string) => void;

async function commandGen(root: string, out: Sink): Promise<number> {
  const skills = await readSkills(root);
  const resolutions = await readResolutions(root);
  const contracts = await readContracts(root, declaredIds(skills));

  const violations = acceptanceViolations(skills, contracts, resolutions);
  if (violations.length > 0) {
    for (const violation of violations) out(violation);
    return 1;
  }
  await executePlan(await planExpansion(root, skills, contracts, resolutions));
  return 0;
}

interface AcceptanceRecord {
  id: string;
  previous: string | null;
  adopted: string;
}

/**
 * The only writer of resolutions, and therefore the boundary at which a change
 * of contract text becomes approved.
 *
 * What protects deliberate adoption is not the command being awkward to run: it
 * is that running it produces something reviewable. The routing metadata below
 * is derived from the lock, which is the authoritative dependency graph, so the
 * list of affected skills cannot drift from the thing it describes.
 */
async function commandAccept(
  root: string,
  ids: string[],
  out: Sink,
): Promise<number> {
  if (ids.length === 0) {
    throw new ConfigError("accept needs at least one contract id");
  }
  for (const [position, id] of ids.entries()) {
    assertValidContractId(id, "accept");
    if (ids.indexOf(id) !== position) {
      throw new ConfigError(`accept was given ${id} more than once`);
    }
  }

  const skills = await readSkills(root);
  const previous = await readResolutions(root);
  const wanted = [...new Set([...ids, ...declaredIds(skills)])].sort(
    compareStrings,
  );
  const contracts = await readContracts(root, wanted);

  const resolutions: Resolutions = { ...previous };
  const records: AcceptanceRecord[] = [];
  for (const id of ids) {
    const contract = contracts.get(id) ?? null;
    if (contract === null) {
      throw new ConfigError(
        `cannot accept ${id}: ${contractPath(id)} does not exist`,
      );
    }
    const resolution: Resolution = { digest: contract.digest };
    const conformance = await conformanceDigest(root, id);
    if (conformance !== null) resolution.conformance = conformance;
    if (contract.version !== undefined) resolution.version = contract.version;
    records.push({
      id,
      previous: previous[id]?.digest ?? null,
      adopted: contract.digest,
    });
    resolutions[id] = resolution;
  }

  const violations = acceptanceViolations(skills, contracts, resolutions);
  if (violations.length > 0) {
    for (const violation of violations) out(violation);
    return 1;
  }
  await executePlan(await planExpansion(root, skills, contracts, resolutions));

  for (const record of records) {
    const dependents = dependentsOf(skills, record.id);
    out(`accepted: ${record.id}`);
    out(`  old-digest: ${record.previous ?? "none (initial adoption)"}`);
    out(`  new-digest: ${record.adopted}`);
    out(
      `  dependents: ${
        dependents.length > 0 ? dependents.join(", ") : "(none)"
      }`,
    );
  }
  return 0;
}

/**
 * Three checks that do not depend on one another: what was accepted against the
 * canonical text, the copies against the pin, and the manifest against what the
 * tree renders to. Keeping them separate is what lets any one of them stay
 * meaningful while another is failing.
 */
async function commandVerify(root: string, out: Sink): Promise<number> {
  const skills = await readSkills(root);
  const resolutions = await readResolutions(root);
  const contracts = await readContracts(root, declaredIds(skills));

  const violations = [
    ...acceptanceViolations(skills, contracts, resolutions),
    ...await copyViolations(root, skills, resolutions),
    ...await manifestViolations(root, skills, resolutions),
    ...await conformanceViolations(root, resolutions),
  ];
  for (const violation of violations) out(violation);
  return violations.length > 0 ? 1 : 0;
}

// --- command line ----------------------------------------------------------

interface Invocation {
  command: string;
  root: string;
  operands: string[];
}

function parseArguments(argv: string[]): Invocation {
  let root = ".";
  let command: string | null = null;
  const operands: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--root") {
      const value = argv[++index];
      if (value === undefined) throw new ConfigError("--root needs a path");
      root = value.replace(/\/+$/, "") || "/";
    } else if (token.startsWith("-")) {
      throw new ConfigError(`unknown option: ${token}`);
    } else if (command === null) {
      command = token;
    } else {
      operands.push(token);
    }
  }
  if (command === null) throw new ConfigError("no command given");
  return { command, root, operands };
}

/**
 * Runs one invocation and answers with its exit code: 0 clean, 1 violations
 * reported on `out`, 2 a configuration or usage error reported on `err`.
 *
 * The process is exited by the entry point below, never in here, so the whole
 * tool stays callable from a test without a subprocess.
 */
export async function run(
  argv: string[],
  out: Sink,
  err: Sink,
): Promise<number> {
  try {
    const invocation = parseArguments(argv);
    switch (invocation.command) {
      case "gen":
        return await commandGen(invocation.root, out);
      case "verify":
        return await commandVerify(invocation.root, out);
      case "accept":
        return await commandAccept(invocation.root, invocation.operands, out);
      default:
        throw new ConfigError(`unknown command: ${invocation.command}`);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      err(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  Deno.exit(
    await run(
      Deno.args,
      (line) => console.log(line),
      (line) => console.error(line),
    ),
  );
}
