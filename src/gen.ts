// gen.ts — writing the accepted contracts into the skills that declare them.
//
// The distribution half of the tool. It reads the canonical contracts, decides
// whether the tree is in a state worth writing, and expands it — building every
// byte before writing any of them, so a tree is never half-updated over
// something the run could have known in advance.
//
// verify.ts and accept.ts build on this module rather than beside it: verify
// checks what this module would write, and accept adopts new text and then asks
// this module to write it. Both therefore share this module's answer to "may
// this tree be expanded at all" instead of restating it.

import * as fs from "node:fs/promises";
import { ConfigError, describeCause, type Sink } from "./errors.ts";
import {
  CONTRACTS_DIR,
  compareStrings,
  canonicalBody,
  contractPath,
  digestOfText,
  splitDocument,
} from "./digest.ts";
import { assertPlainContractPaths } from "./conformance.ts";
import {
  assertPlainChain,
  assertTreeRoot,
  atomicWriteFile,
  ensureParentDirectory,
  isDirectoryOrAbsent,
  isRegularFileOrAbsent,
  readEntries,
  readTextFile,
} from "./walk.ts";
import {
  declaredIds,
  dependenciesOf,
  dependentsOf,
  readSkills,
  type SkillDeclaration,
  SKILLS_DIR,
} from "./declaration.ts";
import {
  buildManifest,
  canonicalJson,
  GENERATOR,
  MANIFEST_FILE,
  presentContractIds,
  readLock,
  type Resolutions,
} from "./manifest.ts";

const VENDOR_SUBPATH = "references/vendor";

export function vendorDirOf(skill: string): string {
  return `${SKILLS_DIR}/${skill}/${VENDOR_SUBPATH}`;
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
      indentOf(candidate) === 0 &&
      candidate.startsWith(`${key}:`) &&
      /^[^:]+:(\s|$)/.test(candidate),
  );
  if (line === undefined) return undefined;
  const value = withoutComment(line)
    .slice(key.length + 1)
    .trim();
  if (value === "") return undefined;
  return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

/**
 * Reads each contract's canonical text, or null where the file is absent.
 *
 * The whole path is checked for links, not just the file at the end of it. A
 * link at `contracts/` makes every contract below it resolve outside the tree,
 * and the run would then digest outside text, pin it, and write it into every
 * vendored copy while reporting nothing — the escape this tool exists to close.
 *
 * The conformance tests beside the text are covered by the same check, although
 * nothing read here lies below their directory. That is the whole point of
 * asking it here: left to the commands that do read them, a link planted there
 * stopped verify while gen expanded the tree without a word.
 *
 * Null means the canonical file is not there at all, and nothing else. Anything
 * standing at the path that is not a file the run can read stops it instead:
 * carried as null it would be reported as a closure gap, which states that the
 * tree does not hold the text — a claim about the tree the run is in no
 * position to make. Keeping the two apart is also what leaves that report
 * truthful, since the only way left to reach it is a file genuinely absent.
 */
export async function readContracts(
  root: string,
  ids: string[],
): Promise<Map<string, CanonicalContract | null>> {
  const contracts = new Map<string, CanonicalContract | null>();
  if (ids.length === 0) return contracts;
  // A file standing at contracts/ made every contract below it read as "does
  // not exist" — the per-path lstat fails with ENOTDIR, which is not the
  // "nothing is there" this function answers with. Asked once, the fact is
  // named as what it is before any contract is looked up.
  await isDirectoryOrAbsent(root, CONTRACTS_DIR);
  for (const id of ids) {
    const site = contractPath(id);
    await assertPlainContractPaths(root, id);
    if (!(await isRegularFileOrAbsent(root, site))) {
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

export interface CanonicalContract {
  digest: string;
  body: string;
  version?: string;
}

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
  return (
    `<!-- DO NOT EDIT. Generated by ${GENERATOR.name}. -->\n` +
    `<!-- contract: ${id} -->\n` +
    `<!-- source-digest: ${digest} -->\n\n`
  );
}

/** The names directly inside a skill's vendor directory. */
export async function listVendorEntries(
  root: string,
  skill: string,
): Promise<string[]> {
  const relative = vendorDirOf(skill);
  await assertPlainChain(root, relative);
  if (!(await isDirectoryOrAbsent(root, relative))) return [];
  const dir = `${root}/${relative}`;
  const names: string[] = [];
  for (const entry of await readEntries(dir, relative)) {
    if (entry.isSymlink) {
      throw new ConfigError(
        `symlink is not allowed inside the tree: ${relative}/${entry.name}`,
      );
    }
    names.push(entry.name);
  }
  return names;
}

/**
 * Every path in a plan is relative to the tree, never absolute. The plan is
 * then a statement about the tree rather than about where the tree happens to
 * sit, and it is the same relative path that every refusal quotes back.
 */
interface WritePlan {
  files: { site: string; content: Uint8Array }[];
  manifest: { site: string; content: Uint8Array };
  removals: string[];
  /**
   * The contract ids whose resolutions the rewritten manifest drops, because
   * their canonical text is gone. Reported by the commands that execute the
   * plan, so a retirement is never silent.
   */
  retired: string[];
}

/**
 * The line a command reports for a resolution the rewritten manifest drops.
 *
 * Shared by gen and accept, so the read of a retirement reads the same both
 * ways.
 */
export function retiredReport(id: string): string {
  return `retired: ${id} (no canonical text; resolution removed from the lock)`;
}

/**
 * Builds every byte the run will write before writing any of them, so that a
 * tree is never half-updated because of something the run could have known in
 * advance.
 */
export async function planExpansion(
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
        site: `${vendorDirOf(skill.name)}/${id}.md`,
        content: encoder.encode(
          renderVendorFile(id, contract.digest, contract.body),
        ),
      });
    }
    for (const name of await listVendorEntries(root, skill.name)) {
      if (!expected.has(name)) {
        removals.push(`${vendorDirOf(skill.name)}/${name}`);
      }
    }
  }
  const present = await presentContractIds(root, resolutions);
  // The resolutions the rewritten manifest drops: the lock's own memory of a
  // contract that no longer has canonical text. The plan reports them so the
  // run that performs the retirement names it instead of staying silent.
  const retired = Object.keys(resolutions)
    .filter((id) => !present.includes(id))
    .sort(compareStrings);
  return {
    files,
    manifest: {
      site: MANIFEST_FILE,
      content: encoder.encode(
        canonicalJson(
          buildManifest(dependenciesOf(skills), resolutions, present),
        ),
      ),
    },
    removals,
    retired,
  };
}

/**
 * Copies first, then the manifest, then the removals.
 *
 * A run stopped part way therefore never loses a file it had not yet replaced,
 * and the state it leaves is one verify reports as a violation rather than one
 * that looks finished.
 *
 * A removal that fails is reported rather than passed over. Because removals
 * run last, stopping here abandons nothing: every copy and the lock are already
 * written, and what the refusal names is the one file the run could not clear.
 * Silence cost more than it saved — gen answered 0 while verify reported the
 * leftover as an extra, and running gen again answered 0 again, so the tree
 * stayed in a state one command called clean and the other called a violation.
 */
export async function executePlan(
  root: string,
  plan: WritePlan,
): Promise<void> {
  for (const file of plan.files) {
    await ensureParentDirectory(root, file.site);
    await atomicWriteFile(root, file.site, file.content);
  }
  await atomicWriteFile(root, plan.manifest.site, plan.manifest.content);
  const failures: { site: string; cause: unknown }[] = [];
  for (const site of plan.removals) {
    try {
      // A path already gone is the state this asks for, not a failure: `force`
      // is what separates "there is nothing to remove" from "this could not be
      // removed", and only the second is worth stopping over.
      await fs.rm(`${root}/${site}`, { recursive: true, force: true });
    } catch (cause) {
      // Every removal is attempted before any of them is reported, so one file
      // that cannot be cleared does not leave the rest standing behind it.
      failures.push({ site, cause });
    }
  }
  if (failures.length > 0) {
    const [first] = failures;
    throw new ConfigError(
      `cannot remove ${first.site}: ${describeCause(first.cause)}`,
    );
  }
}

/**
 * The half of verification that compares canonical text against what was
 * accepted. gen runs exactly these checks and refuses to expand while any of
 * them holds, so no vendored copy can carry text nobody approved.
 */
export function acceptanceViolations(
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
        `closure: ${id} is declared by ${dependents} but ${contractPath(
          id,
        )} does not exist`,
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
        `unaccepted-drift: ${id} is resolved to ${resolution.digest} but ${contractPath(
          id,
        )} is ${contract.digest}; accept ${id} to adopt the new text`,
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
export async function commandGen(root: string, out: Sink): Promise<number> {
  await assertTreeRoot(root);
  const { recordedSkills, resolutions } = await readLock(root);
  const skills = await readSkills(root, recordedSkills);
  const contracts = await readContracts(root, declaredIds(skills));

  const violations = acceptanceViolations(skills, contracts, resolutions);
  if (violations.length > 0) {
    for (const violation of violations) out(violation);
    return 1;
  }
  const plan = await planExpansion(root, skills, contracts, resolutions);
  await executePlan(root, plan);
  for (const id of plan.retired) out(retiredReport(id));
  return 0;
}
