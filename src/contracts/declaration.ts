// declaration.ts — what a skill says it depends on.
//
import {
  CORE_SCHEMA,
  loadAll as parseYamlDocuments,
  mergeTag,
  Schema,
} from "js-yaml";
import { ConfigError, describeCause } from "../errors.ts";
import { assertValidContractId, splitDocument } from "./digest.ts";
import { compareStrings } from "../ordering.ts";
import {
  displayName,
  isDirectoryOrAbsent,
  isRegularFileOrAbsent,
  listEntries,
  readTextFile,
} from "../filesystem/walk.ts";
import { emptyRecord } from "../records.ts";

/** Where the skills live, and what names a skill's own document. */
export const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";

/** A skill's own document, relative to the tree root. */
function skillFileOf(skill: string): string {
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
 * YAML 1.2's core schema with the merge key put back.
 *
 * A merge key is one of YAML's spellings of "these entries belong here", and
 * the parser this tool read frontmatter with before resolved it. Left out, `<<`
 * survives as a literal key: a `metadata` block assembled through one loses its
 * `contracts` and the skill is answered with "declares nothing" — the silent
 * unpin this module is built to make impossible. Nothing else is added, so the
 * types a scalar can take are still YAML 1.2's.
 */
const DECLARATION_SCHEMA = new Schema([...CORE_SCHEMA.tags, mergeTag]);

/**
 * The frontmatter as YAML reads it, or null when it holds nothing.
 *
 * A tab anywhere in a line's indentation is refused before the parser sees it.
 * The parser in use refuses one itself, so today this changes only which
 * message a reader gets. It is kept because the failure it guards against is
 * silent and the guard is not: a parser that tolerated a tab would read the
 * line as a sibling of the block it was indented under, so a `contracts` key
 * typed with a tab would become a top-level key, `metadata` would lose it, and
 * the skill would be answered with "declares nothing". Which parser reads this
 * frontmatter has already changed once, and this rule is what makes that
 * change unable to unpin a skill quietly.
 *
 * The rule is blunt on purpose: inside a block scalar a leading tab is content,
 * and YAML allows it, but this refuses it too. Telling the two apart means
 * knowing which lines are inside a block scalar, which means parsing — and the
 * parse is the step being protected. Refusing a legal document loudly is the
 * affordable half of that trade; accepting an illegal one silently is not.
 */
function parseFrontmatter(lines: string[], site: string): unknown {
  const tabbed = lines.find((line) => /^[ \t]*\t/.test(line));
  if (tabbed !== undefined) {
    throw new ConfigError(
      `${site}: frontmatter is indented with a tab, which YAML does not allow: ${JSON.stringify(
        tabbed,
      )}`,
    );
  }
  let documents: unknown[];
  try {
    documents = parseYamlDocuments(lines.join("\n"), {
      schema: DECLARATION_SCHEMA,
    });
  } catch (cause) {
    throw new ConfigError(
      `${site}: frontmatter is not readable YAML: ${describeCause(cause)}`,
    );
  }
  // A block that opens no document at all — empty, or nothing but comments —
  // declares nothing. Asking for the documents rather than for "the document"
  // is what makes that answer the parser's rather than a guess: YAML readers
  // disagree over what a single empty document should be, and none of them
  // disagrees over there being none.
  if (documents.length === 0) return null;
  // Unreachable through splitDocument, which ends the frontmatter at the first
  // closing delimiter. Refused rather than reasoned about: silently reading the
  // first of several documents is the shape of failure this module exists to
  // rule out.
  if (documents.length > 1) {
    throw new ConfigError(
      `${site}: frontmatter holds ${documents.length} YAML documents, not one`,
    );
  }
  return documents[0];
}

/** The value as a mapping, or a refusal naming what was found instead. */
function requireMapping(
  value: unknown,
  label: string,
  site: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
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
      `${site}: metadata.contracts must be a list of contract ids, found ${JSON.stringify(
        value,
      )}`,
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
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
    if (seen.has(entry)) {
      throw new ConfigError(
        `${site}: contract declared more than once: ${entry}`,
      );
    }
    seen.add(entry);
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

/**
 * Every skill directly under skills/, with the contracts it declares.
 *
 * `recorded` names the skills the lock remembers. A name it holds must still
 * be a directory: anything else standing there — a file, a pipe — is read as
 * "no such skill", and the run then rewrites the lock without it and clears
 * the vendored copies it accounted for, retiring a whole skill because
 * something appeared over its directory.
 *
 * A name the lock has never held is left alone. A consuming repository may
 * keep a README or anything else beside its skills, and no rule about what
 * may sit under skills/ is being declared here — only that a skill the tree
 * already knew about cannot quietly stop being one.
 */
export async function readSkills(
  root: string,
  recorded: ReadonlySet<string>,
): Promise<SkillDeclaration[]> {
  if (!(await isDirectoryOrAbsent(root, SKILLS_DIR))) return [];
  const skillsDir = `${root}/${SKILLS_DIR}`;
  const names: string[] = [];
  for (const entry of await listEntries(skillsDir, SKILLS_DIR)) {
    if (entry.isDirectory) {
      names.push(entry.name);
      continue;
    }
    if (recorded.has(entry.name)) {
      throw new ConfigError(
        `${displayName(`${SKILLS_DIR}/${entry.name}`)} is recorded in the lock but is not a directory`,
      );
    }
  }

  const skills: SkillDeclaration[] = [];
  for (const name of names) {
    skills.push({ name, contracts: await declaredContracts(root, name) });
  }
  return skills;
}

/**
 * The contracts a skill declares, or none where it holds no SKILL.md at all.
 *
 * A directory with no SKILL.md declares nothing, but it is still listed:
 * otherwise a vendored copy left under it would be invisible to both the check
 * for unaccounted copies and the removal that clears them.
 *
 * That is the only way reading may find no declaration. Anything else standing
 * at the path stops the run instead, because taken for "no SKILL.md" it retires
 * every contract the skill declares without a word — and gen then deletes the
 * vendored copies those declarations accounted for, and finishes reporting
 * nothing. The link is refused before the kind is: a planted link is the more
 * specific fact, and the one worth naming.
 */
async function declaredContracts(
  root: string,
  name: string,
): Promise<string[]> {
  const site = skillFileOf(name);
  if (await isRegularFileOrAbsent(root, site)) {
    return parseContractDeclarations(
      await readTextFile(`${root}/${site}`, site),
      site,
    );
  }
  return [];
}

/** The declared contract ids across all skills, without duplicates. */
export function declaredIds(skills: SkillDeclaration[]): string[] {
  const ids = new Set<string>();
  for (const skill of skills) for (const id of skill.contracts) ids.add(id);
  return [...ids].sort(compareStrings);
}

/**
 * The reverse of `dependentsOf`: one lookup from a contract id to the skills
 * that declare it.
 *
 * Built once for a set of skills that is queried repeatedly. Rescanning every
 * skill's contract list per id would pay skills × contracts per lookup; the
 * index pays the same scan once and answers each following id with a map
 * lookup.
 */
export function dependentIndex(
  skills: SkillDeclaration[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const skill of skills) {
    for (const id of skill.contracts) {
      const dependents = index.get(id);
      if (dependents === undefined) {
        index.set(id, [skill.name]);
      } else {
        dependents.push(skill.name);
      }
    }
  }
  for (const names of index.values()) names.sort(compareStrings);
  return index;
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
  const dependencies: Dependencies = emptyRecord();
  for (const skill of skills) {
    if (skill.contracts.length === 0) continue;
    dependencies[skill.name] = [...skill.contracts].sort(compareStrings);
  }
  return dependencies;
}
