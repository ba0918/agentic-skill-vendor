// declaration.ts — what a skill says it depends on.
//
// Frontmatter is read by a YAML parser, and what the tool refuses is stated as
// a schema over the parse result rather than as a grammar of accepted lines. A
// hand-written line grammar has to decide what every unfamiliar shape means,
// and its answer for "I cannot read this" was the empty declaration list — a
// skill that believed it was pinned would be silently unpinned. Reading first
// and judging second makes that answer impossible: an unreadable document
// raises, and a readable one is judged against rules that name what they want.

import { parse as parseYaml } from "@std/yaml";
import { ConfigError, describeCause } from "./errors.ts";
import {
  assertValidContractId,
  compareStrings,
  splitDocument,
} from "./digest.ts";
import { isDirectory, isRegularFile, readTextFile } from "./walk.ts";

/** Where the skills live, and what names a skill's own document. */
export const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";

/** A skill's own document, relative to the tree root. */
export function skillFileOf(skill: string): string {
  return `${SKILLS_DIR}/${skill}/${SKILL_FILE}`;
}

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

export interface SkillDeclaration {
  name: string;
  contracts: string[];
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

export function dependentsOf(skills: SkillDeclaration[], id: string): string[] {
  return skills.filter((skill) => skill.contracts.includes(id)).map((skill) =>
    skill.name
  )
    .sort(compareStrings);
}

/** The dependency half of the lock: a skill mapped to what it declares. */
export type Dependencies = Record<string, string[]>;

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
