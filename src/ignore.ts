// ignore.ts — which files the tree carries, answered the way git answers it.
//
// Whether a file belongs to a repository is a question .gitignore already
// answers. Restating the answer as a list built into this tool would be a
// second copy of it, and a copy of a rule set diverges silently.

import ignore, { type Ignore } from "ignore";
import { compareStrings } from "./digest.ts";
import { isRegularFile, readTextFile } from "./walk.ts";

/** The file git reads its rules from, in every directory that has one. */
export const IGNORE_FILE = ".gitignore";

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
export function treeDirectoryOf(relative: string): string {
  const cut = relative.lastIndexOf("/");
  return cut === -1 ? "" : relative.slice(0, cut);
}

export function joinRelative(prefix: string, relative: string): string {
  if (prefix === "") return relative;
  return relative === "" ? prefix : `${prefix}/${relative}`;
}

/** The tree root, then each directory down to `relative`, ending with it. */
export function ancestorDirectories(relative: string): string[] {
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
