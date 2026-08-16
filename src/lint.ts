// lint.ts — whether a skill directory can be moved on its own.
//
// Portability, not identity: a skill directory has to be movable on its own, so
// nothing inside it may point above itself. This is the third thing the tool
// does, kept apart from gen and accept (which change the distributed state) and
// from verify (which decides identity).

import * as fs from "node:fs/promises";
import { ConfigError, type Sink } from "./errors.ts";
import { isDirectory, readEntries } from "./walk.ts";
import { SKILLS_DIR } from "./declaration.ts";

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
  /(?:^|(?<=[\s"'`=([,;]))(?:\/[^\s"'`)\]/]+\/[^\s"'`)\]]+|~\/[^\s"'`)\]]*|[A-Za-z]:[\\/][^\s"'`)\]]+)/g;

function decodeForScan(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Every one of the 256 bytes maps to a character here, so a file that is
    // not UTF-8 is still scanned to its last line instead of being skipped.
    // Which single-byte encoding it is does not matter: the patterns above are
    // pure ASCII, and every one of them agrees throughout the ASCII range.
    return new TextDecoder("windows-1252").decode(bytes);
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
        line =
          " ".repeat(interpreter[0].length) + line.slice(interpreter[0].length);
      }
    }
    for (const match of line.matchAll(ABSOLUTE_PATH)) {
      violations.push(
        `absolute-path: ${where}: absolute reference ${JSON.stringify(
          match[0],
        )}`,
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
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

/** Where a link points, resolved without requiring the target to exist. */
async function resolveLink(path: string): Promise<string> {
  const target = await fs.readlink(path);
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
  for (const entry of await readEntries(dir)) {
    const path = `${dir}/${entry.name}`;
    const site = `${relative}/${entry.name}`;
    if (entry.isSymlink) {
      violations.push(...(await symlinkViolations(root, path, site)));
      continue;
    }
    if (entry.isDirectory) {
      await lintInto(root, path, site, violations);
    } else {
      violations.push(
        ...lintLines(site, decodeForScan(await fs.readFile(path))),
      );
    }
  }
}

export async function commandLint(root: string, out: Sink): Promise<number> {
  const skillsDir = `${root}/${SKILLS_DIR}`;
  if (!(await isDirectory(skillsDir))) {
    throw new ConfigError(`${SKILLS_DIR}/ does not exist under ${root}`);
  }
  const violations: string[] = [];
  await lintInto(root, skillsDir, SKILLS_DIR, violations);
  for (const violation of violations) out(violation);
  return violations.length > 0 ? 1 : 0;
}
