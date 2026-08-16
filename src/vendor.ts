// vendor.ts — vendors shared reference documents into a skill repository.
//
// Run with `deno run --allow-read --allow-write vendor.ts <cmd>`. Read and
// write are the only permissions the tool asks for, and the dependencies it
// reaches for do not widen that: parsing text needs nothing from the network,
// the environment, or a subprocess.

import { parse as parseYaml } from "@std/yaml";
import ignore, { type Ignore } from "ignore";
import { ConfigError, describeCause, type Sink } from "./errors.ts";
import {
  assertValidContractId,
  canonicalBody,
  compareStrings,
  concatBytes,
  contractDigest,
  contractPath,
  CONTRACTS_DIR,
  DIGEST_PREFIX,
  digestOfBytes,
  digestOfText,
  splitDocument,
} from "./digest.ts";
import {
  assertPlainChain,
  atomicWriteFile,
  decodeUtf8,
  ensureParentDirectory,
  isDirectory,
  isRegularFile,
  readTextFile,
  walkFiles,
} from "./walk.ts";

export * from "./walk.ts";
export { ConfigError };
export type { Sink };
export * from "./digest.ts";

const IGNORE_FILE = ".gitignore";

// --- declaration parsing ---------------------------------------------------

// Frontmatter is read by a YAML parser, and what the tool refuses is stated as
// a schema over the parse result rather than as a grammar of accepted lines. A
// hand-written line grammar has to decide what every unfamiliar shape means,
// and its answer for "I cannot read this" was the empty declaration list — a
// skill that believed it was pinned would be silently unpinned. Reading first
// and judging second makes that answer impossible: an unreadable document
// raises, and a readable one is judged against rules that name what they want.

/**
 * The frontmatter as YAML reads it, or null when it holds nothing.
 *
 * A tab anywhere in a line's indentation is refused before the parser sees it.
 * YAML forbids a tab there, but this parser tolerates one and goes on to read
 * the line as a sibling of the block it was indented under — so a `contracts`
 * key typed with a tab becomes a top-level key, `metadata` loses it, and the
 * skill is answered with "declares nothing". Refusing the tab is what keeps
 * that reinterpretation from ever being reached.
 */
function parseFrontmatter(lines: string[], site: string): unknown {
  const tabbed = lines.find((line) => /^[ \t]*\t/.test(line));
  if (tabbed !== undefined) {
    throw new ConfigError(
      `${site}: frontmatter is indented with a tab, which YAML does not allow: ${
        JSON.stringify(tabbed)
      }`,
    );
  }
  try {
    return parseYaml(lines.join("\n"));
  } catch (cause) {
    throw new ConfigError(
      `${site}: frontmatter is not readable YAML: ${describeCause(cause)}`,
    );
  }
}

/** The value as a mapping, or a refusal naming what was found instead. */
function requireMapping(
  value: unknown,
  label: string,
  site: string,
): Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
  ) {
    throw new ConfigError(
      `${site}: ${label} must be a mapping, found ${JSON.stringify(value)}`,
    );
  }
  return value as Record<string, unknown>;
}

/**
 * The contract ids a SKILL.md declares, in declaration order.
 *
 * A skill declares nothing only when the document says so — no frontmatter, no
 * `metadata`, or a metadata mapping carrying no `contracts` key. Every other
 * answer the tool cannot turn into a list of ids stops the run, because reading
 * an unreadable declaration as an absent one would silently unpin a skill that
 * believes it is pinned.
 */
export function parseContractDeclarations(
  text: string,
  site: string,
): string[] {
  const document = parseFrontmatter(
    splitDocument(text, site).frontmatter,
    site,
  );
  if (document === null || document === undefined) return [];
  const root = requireMapping(document, "frontmatter", site);
  if (!("metadata" in root)) return [];
  const metadata = requireMapping(root["metadata"], "metadata", site);
  if (!("contracts" in metadata)) return [];
  return readContractIds(metadata["contracts"], site);
}

/**
 * The declaration schema: `metadata.contracts` is a non-empty list of contract
 * ids written as text, each usable as a path component and named once.
 */
function readContractIds(value: unknown, site: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${site}: metadata.contracts must be a list of contract ids, found ${
        JSON.stringify(value)
      }`,
    );
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (entry !== null && typeof entry === "object") {
      // The pin belongs to the lock, not to the skill. A digest written here
      // would put the skill's SKILL.md into the diff of every contract update,
      // which is exactly what declaring by id alone exists to prevent.
      throw new ConfigError(
        `${site}: metadata.contracts entries name a contract id and nothing else; ` +
          `digests live in the lock: ${JSON.stringify(entry)}`,
      );
    }
    if (typeof entry !== "string") {
      throw new ConfigError(
        `${site}: metadata.contracts entries must be contract ids written as text, found ${
          JSON.stringify(entry) ?? "nothing"
        }`,
      );
    }
    assertValidContractId(entry, site);
    if (ids.includes(entry)) {
      throw new ConfigError(
        `${site}: contract declared more than once: ${entry}`,
      );
    }
    ids.push(entry);
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

/**
 * Reads a conformance tree, or nothing at all when the directory is absent.
 *
 * Files the tree's .gitignore rules exclude are left out. What is pinned is
 * what the repository carries, and a file git does not carry cannot be part of
 * that: a fresh checkout would not have it, so digesting it would report a
 * mismatch against a tree nobody changed.
 *
 * The links are refused before the exclusion is applied, never after. Leaving
 * an ignored subtree unscanned would mean a link planted inside it escaped the
 * check that exists to catch it — exclusion narrows what is digested, not what
 * is looked at.
 */
export async function collectConformanceEntries(
  root: string,
  relative: string,
): Promise<ConformanceEntry[]> {
  const dir = `${root}/${relative}`;
  if (!await isDirectory(dir)) return [];
  const found = await walkFiles(dir);
  const rules = await readIgnoreRules(root, [
    ...ancestorDirectories(relative),
    ...found
      .filter((path) => baseNameOf(path) === IGNORE_FILE)
      .map((path) => joinRelative(relative, treeDirectoryOf(path))),
  ]);
  const entries: ConformanceEntry[] = [];
  for (const path of found) {
    if (rules.excludes(joinRelative(relative, path))) continue;
    entries.push({ path, content: await Deno.readFile(`${dir}/${path}`) });
  }
  return entries;
}

/**
 * The conformance digest pinned for one contract, or null when the contract
 * ships no conformance tests.
 *
 * A directory holding nothing after the exclusion counts as absent, the same as
 * no directory at all: git cannot store an empty directory, so a fresh checkout
 * drops it and any other reading would report a false mismatch.
 */
export async function conformanceDigest(
  root: string,
  id: string,
): Promise<string | null> {
  const entries = await collectConformanceEntries(
    root,
    `${CONTRACTS_DIR}/${id}/conformance`,
  );
  if (entries.length === 0) return null;
  return await conformanceDigestOfEntries(entries);
}

// --- ignore rules ----------------------------------------------------------

// Which files a tree carries is git's question, and .gitignore is where a
// repository already answers it. Restating the answer as a list built into this
// tool — the compiled-bytecode directory it used to name — would be a second,
// silently diverging copy of it.

interface IgnoreLevel {
  /** Where the rules were read, relative to the tree root; "" is the root. */
  directory: string;
  matcher: Ignore;
}

export interface IgnoreRules {
  /** True when the rules exclude this tree-relative path. */
  excludes(relative: string): boolean;
}

/** The directory a tree-relative path sits in; "" for one at the tree root. */
function treeDirectoryOf(relative: string): string {
  const cut = relative.lastIndexOf("/");
  return cut === -1 ? "" : relative.slice(0, cut);
}

function joinRelative(prefix: string, relative: string): string {
  if (prefix === "") return relative;
  return relative === "" ? prefix : `${prefix}/${relative}`;
}

/** The tree root, then each directory down to `relative`, ending with it. */
function ancestorDirectories(relative: string): string[] {
  const directories = [""];
  let path = "";
  for (const part of relative.split("/")) {
    path = joinRelative(path, part);
    directories.push(path);
  }
  return directories;
}

function depthOf(directory: string): number {
  return directory === "" ? 0 : directory.split("/").length;
}

/**
 * Reads the .gitignore of each named directory, shallowest first.
 *
 * Nothing above the tree root is read. The root is the boundary this tool was
 * pointed at, and a rule outside it would make the digest depend on a file the
 * tree does not contain.
 */
export async function readIgnoreRules(
  root: string,
  directories: string[],
): Promise<IgnoreRules> {
  const levels: IgnoreLevel[] = [];
  for (
    const directory of [...new Set(directories)].sort(
      (a, b) => depthOf(a) - depthOf(b) || compareStrings(a, b),
    )
  ) {
    const site = joinRelative(directory, IGNORE_FILE);
    if (!await isRegularFile(`${root}/${site}`)) continue;
    levels.push({
      directory,
      matcher: ignore().add(await readTextFile(`${root}/${site}`, site)),
    });
  }
  return { excludes: (relative) => excludedBy(levels, relative) };
}

/**
 * Applies the rules the way git orders them: a directory is judged before
 * anything inside it, and a rule closer to the file wins over one further up.
 *
 * Judging the directories first is what makes an exclusion final. Git never
 * looks inside a directory it has excluded, so a rule written under one cannot
 * bring a file back; deciding per path component reproduces that instead of
 * letting the deepest rule re-include what its own directory already lost.
 */
function excludedBy(levels: IgnoreLevel[], relative: string): boolean {
  const parts = relative.split("/");
  for (let depth = 0; depth < parts.length; depth++) {
    const candidate = parts.slice(0, depth + 1).join("/");
    if (verdictFor(levels, candidate, depth < parts.length - 1)) return true;
  }
  return false;
}

function verdictFor(
  levels: IgnoreLevel[],
  candidate: string,
  isDirectory: boolean,
): boolean {
  let excluded = false;
  for (const level of levels) {
    // A .gitignore inside the candidate directory, or beside it in a sibling
    // one, has no say about the candidate itself.
    const inside = level.directory === "" ||
      candidate.startsWith(`${level.directory}/`);
    if (!inside) continue;
    const local = level.directory === ""
      ? candidate
      : candidate.slice(level.directory.length + 1);
    // A directory is probed with a trailing slash: that is what tells a
    // `name/` rule apart from a `name` one.
    const verdict = level.matcher.test(isDirectory ? `${local}/` : local);
    if (verdict.ignored) excluded = true;
    else if (verdict.unignored) excluded = false;
  }
  return excluded;
}

// --- tree layout -----------------------------------------------------------

const MANIFEST_FILE = "vendor-manifest.json";
const SKILLS_DIR = "skills";
const VENDOR_SUBPATH = "references/vendor";
const SKILL_FILE = "SKILL.md";
const DIGEST_FORM = /^sha256:[0-9a-f]{64}$/;

const GENERATOR = {
  name: "vendor.ts",
  version: "1.0.0",
  source: "https://github.com/ba0918/agentic-skill-shared-reference-vendoring",
} as const;

function vendorDirOf(skill: string): string {
  return `${SKILLS_DIR}/${skill}/${VENDOR_SUBPATH}`;
}

function skillFileOf(skill: string): string {
  return `${SKILLS_DIR}/${skill}/${SKILL_FILE}`;
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

/**
 * The manifest as the declarations, the resolutions and the present contracts
 * render to it.
 *
 * `present` names the contracts whose canonical file the tree actually holds,
 * and provenance is limited to those. A source path recorded for a contract
 * that has been withdrawn would name a file no reader can open, and provenance
 * exists to say where text came from — not where it used to.
 */
export function buildManifest(
  dependencies: Dependencies,
  resolutions: Resolutions,
  present: string[],
): unknown {
  const contracts: Record<string, { source: string }> = {};
  for (const id of [...present].sort(compareStrings)) {
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

/**
 * The resolved contracts whose canonical file the tree holds.
 *
 * Every command that renders a manifest asks this one question through this one
 * function. Two commands answering it differently would make the manifest gen
 * writes differ from the manifest verify expects, and the difference would be
 * reported as a stale manifest that regenerating never fixes.
 */
export async function presentContractIds(
  root: string,
  resolutions: Resolutions,
): Promise<string[]> {
  const present: string[] = [];
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    if (await isRegularFile(`${root}/${contractPath(id)}`)) present.push(id);
  }
  return present;
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

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Drops a trailing comment. No value read by the scanner below holds a '#'. */
function withoutComment(text: string): string {
  if (text.trimStart().startsWith("#")) return "";
  const start = text.indexOf(" #");
  return start === -1 ? text : text.slice(0, start);
}

/**
 * A top-level scalar in a contract's frontmatter, read by scanning lines rather
 * than by parsing the document.
 *
 * Deliberately not the YAML parser that reads declarations. The only value read
 * this way is `version`, which is display-only: no pin, no path, and no
 * decision depends on it, so an unreadable frontmatter here has nothing to
 * unpin. Parsing it strictly would instead turn a contract whose text digests
 * perfectly well into a run that refuses to work at all.
 */
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
        canonicalJson(
          buildManifest(
            dependenciesOf(skills),
            resolutions,
            await presentContractIds(root, resolutions),
          ),
        ),
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
    buildManifest(
      dependenciesOf(skills),
      resolutions,
      await presentContractIds(root, resolutions),
    ),
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

// --- self-containment lint -------------------------------------------------

// Portability, not identity: a skill directory has to be movable on its own,
// so nothing inside it may point above itself. This is the third thing the tool
// does, kept apart from gen and accept (which change the distributed state) and
// from verify (which decides identity).

const PARENT_ESCAPE_TOKENS = ["../", "..\\"];

// A token is an absolute reference when it begins at a reference boundary —
// start of line, whitespace, a quote, '=', '(', '[', ',' or ';' — and is rooted
// outside the skill: a '/' with at least two segments, so prose such as '/help'
// is not mistaken for a path; a '~/'; or a Windows drive.
//
// ':' is deliberately not a boundary. That single omission is the whole reason
// URLs are excluded: the slashes in "https://example.com/guide" are preceded by
// ':' or by an ordinary character, never by a boundary, so no URL can match. A
// dedicated URL pattern would have to be kept in step with every scheme.
const ABSOLUTE_PATH =
  /(?:^|(?<=[\s"'`=(\[,;]))(?:\/[^\s"'`)\]\/]+\/[^\s"'`)\]]+|~\/[^\s"'`)\]]*|[A-Za-z]:[\\\/][^\s"'`)\]]+)/g;

function decodeForScan(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Every one of the 256 bytes maps to a character here, so a file that is
    // not UTF-8 is still scanned to its last line instead of being skipped.
    // The label resolves to windows-1252 rather than true ISO-8859-1, which
    // does not matter: the patterns above are pure ASCII, and the two
    // encodings agree throughout the ASCII range.
    return new TextDecoder("latin1").decode(bytes);
  }
}

function lintLines(site: string, text: string): string[] {
  const violations: string[] = [];
  for (const [index, original] of text.split("\n").entries()) {
    const number = index + 1;
    const where = `${site}:${number}`;
    if (PARENT_ESCAPE_TOKENS.some((token) => original.includes(token))) {
      violations.push(
        `parent-escape: ${where}: reference above the skill directory`,
      );
    }
    let line = original;
    if (number === 1 && line.startsWith("#!")) {
      // A shebang names an interpreter for the operating system, not a file the
      // skill reads, so that one token cannot break self-containment. Only the
      // token is exempt: blanking it rather than deleting it keeps the columns
      // and leaves a whitespace boundary before anything that follows, so a
      // real path later on the same line is still found.
      const interpreter = /^#!\s*\S*/.exec(line);
      if (interpreter !== null) {
        line = " ".repeat(interpreter[0].length) +
          line.slice(interpreter[0].length);
      }
    }
    for (const match of line.matchAll(ABSOLUTE_PATH)) {
      violations.push(
        `absolute-path: ${where}: absolute reference ${
          JSON.stringify(match[0])
        }`,
      );
    }
  }
  return violations;
}

/** The directory the path sits in; the current directory when it names none. */
export function dirNameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "." : path.slice(0, cut);
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + parts.join("/");
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

/** Where a link points, resolved without requiring the target to exist. */
async function resolveLink(path: string): Promise<string> {
  const target = await Deno.readLink(path);
  const joined = target.startsWith("/")
    ? target
    : `${dirNameOf(path)}/${target}`;
  const normalized = normalizePath(joined);
  const parent = await realPathOrNull(dirNameOf(normalized));
  return parent === null ? normalized : `${parent}/${baseNameOf(normalized)}`;
}

/**
 * A link is judged by where it resolves, not by any text: a link out of the
 * skill is an escape even though no path string appears in any file.
 */
async function symlinkViolations(
  root: string,
  path: string,
  relative: string,
): Promise<string[]> {
  const skillName = relative.split("/")[1];
  const skillsReal = await realPathOrNull(`${root}/${SKILLS_DIR}`);
  if (skillsReal === null) {
    throw new ConfigError(`cannot inspect ${SKILLS_DIR}/`);
  }
  // The parents are resolved but the entry itself never is. A skills/<name>
  // that is itself a link would otherwise resolve to its own target first and
  // count as trivially inside itself.
  const boundary = `${skillsReal}/${skillName}`;
  const resolved = await resolveLink(path);
  if (resolved === boundary || resolved.startsWith(`${boundary}/`)) return [];
  return [
    `symlink-escape: ${relative}: symlink resolves outside the skill directory`,
  ];
}

async function lintInto(
  root: string,
  dir: string,
  relative: string,
  violations: string[],
): Promise<void> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) entries.push(entry);
  entries.sort((a, b) => compareStrings(a.name, b.name));
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    const site = `${relative}/${entry.name}`;
    if (entry.isSymlink) {
      violations.push(...await symlinkViolations(root, path, site));
      continue;
    }
    if (entry.isDirectory) {
      await lintInto(root, path, site, violations);
    } else {
      violations.push(
        ...lintLines(site, decodeForScan(await Deno.readFile(path))),
      );
    }
  }
}

async function commandLint(root: string, out: Sink): Promise<number> {
  const skillsDir = `${root}/${SKILLS_DIR}`;
  if (!await isDirectory(skillsDir)) {
    throw new ConfigError(`${SKILLS_DIR}/ does not exist under ${root}`);
  }
  const violations: string[] = [];
  await lintInto(root, skillsDir, SKILLS_DIR, violations);
  for (const violation of violations) out(violation);
  return violations.length > 0 ? 1 : 0;
}

// --- commands --------------------------------------------------------------

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

// --- self diagnosis --------------------------------------------------------

// A consumer verifies this file in two steps: the sha256 of the file, then this
// command. The first step proves the file is the one that was reviewed; the
// second proves the file it received still computes what it is supposed to.
// Neither step trusts the tool to approve a newer version of itself.
//
// The vectors below were normalized and hashed by hand, outside this code, so
// they are an independent statement of the answer rather than a recording of
// whatever the implementation happened to produce.

const SELF_TEST_DOCUMENT =
  '---\r\nversion: "1"\r\n---\r\n\r\nHello  \r\nWorld\r\n\r\n\r\n';
const SELF_TEST_DIGEST =
  "sha256:f5755ff05efa18e544073833aa1963073a8eb5f80a817564228b5b44a27bd96a";
const SELF_TEST_CONFORMANCE =
  "sha256:7bfb47738b94157bbf9d0b7de2a62a9c775f5bd67891dadf284be77d2bddea2e";
const SELF_TEST_HEADER = "<!-- DO NOT EDIT. Generated by vendor.ts. -->\n" +
  "<!-- contract: sample-contract -->\n" +
  "<!-- source-digest: sha256:" + "0".repeat(64) + " -->\n\nBody\n";

async function selfTestFailures(): Promise<string[]> {
  const encoder = new TextEncoder();
  const checks = [
    {
      name: "contract digest",
      expected: SELF_TEST_DIGEST,
      computed: await contractDigest(SELF_TEST_DOCUMENT),
    },
    {
      name: "conformance framing",
      expected: SELF_TEST_CONFORMANCE,
      computed: await conformanceDigestOfEntries([
        { path: "b.txt", content: encoder.encode("B\n") },
        { path: "a/x.txt", content: encoder.encode("XY") },
      ]),
    },
    {
      name: "vendored copy header",
      expected: SELF_TEST_HEADER,
      computed: renderVendorFile(
        "sample-contract",
        `${DIGEST_PREFIX}${"0".repeat(64)}`,
        "Body\n",
      ),
    },
  ];
  return checks
    .filter((check) => check.computed !== check.expected)
    .map((check) =>
      `self-test: ${check.name}: computed ${JSON.stringify(check.computed)}, ` +
      `the embedded vector says ${JSON.stringify(check.expected)}`
    );
}

/** Checks this file against its own vectors. Reads and writes nothing. */
async function commandSelfTest(out: Sink): Promise<number> {
  const failures = await selfTestFailures();
  for (const failure of failures) out(failure);
  return failures.length > 0 ? 1 : 0;
}

// --- command line ----------------------------------------------------------

const USAGE = [
  "usage: vendor.ts <command> [--root <path>]",
  "",
  "commands:",
  "  gen                      write the accepted contracts into every skill",
  "  verify                   check the tree against the lock",
  "  accept <contract-id>...  adopt the current text of the named contracts",
  "  lint-selfcontain         check that no skill points outside itself",
  "  self-test                check this file against its embedded vectors",
  "",
  "options:",
  "  --root <path>            the tree to work on (default: .)",
  "",
  "exit codes: 0 nothing to report, 1 violations listed on stdout,",
  "            2 a configuration or usage error described on stderr",
].join("\n");

interface Invocation {
  command: string;
  root: string;
  operands: string[];
}

function parseArguments(argv: string[]): Invocation | "help" {
  let root = ".";
  let command: string | null = null;
  const operands: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return "help";
    if (token === "--root") {
      const value = argv[++index];
      if (value === undefined) throw new ConfigError("--root needs a path");
      root = value.replace(/\/+$/, "") || "/";
    } else if (token.startsWith("-")) {
      throw new ConfigError(`unknown option: ${token}\n${USAGE}`);
    } else if (command === null) {
      command = token;
    } else {
      operands.push(token);
    }
  }
  if (command === null) throw new ConfigError(`no command given\n${USAGE}`);
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
    if (invocation === "help") {
      out(USAGE);
      return 0;
    }
    switch (invocation.command) {
      case "gen":
        return await commandGen(invocation.root, out);
      case "verify":
        return await commandVerify(invocation.root, out);
      case "accept":
        return await commandAccept(invocation.root, invocation.operands, out);
      case "lint-selfcontain":
        return await commandLint(invocation.root, out);
      case "self-test":
        return await commandSelfTest(out);
      default:
        throw new ConfigError(
          `unknown command: ${invocation.command}\n${USAGE}`,
        );
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
