// lint.ts — whether a skill directory can be moved on its own.
//
// Portability, not identity: a skill directory has to be movable on its own, so
// nothing inside it may point above itself. This is the third thing the tool
// does, kept apart from gen and accept (which change the distributed state) and
// from verify (which decides identity).

import * as fs from "node:fs/promises";
import { ConfigError, describeCause, type Sink } from "./errors.ts";
import {
  assertTreeRoot,
  dirNameOf,
  displayName,
  isDirectoryOrAbsent,
  readBytes,
  readEntries,
} from "./walk.ts";
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

// Reused rather than built per file: a decoder is stateless between decode
// calls, and the scan reads a whole file in one call.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const WINDOWS_1252_DECODER = new TextDecoder("windows-1252");

function decodeForScan(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    // Every one of the 256 bytes maps to a character here, so a file that is
    // not UTF-8 is still scanned to its last line instead of being skipped.
    // Which single-byte encoding it is does not matter: the patterns above are
    // pure ASCII, and every one of them agrees throughout the ASCII range.
    return WINDOWS_1252_DECODER.decode(bytes);
  }
}

function lintLines(site: string, text: string): string[] {
  const violations: string[] = [];
  for (const [index, original] of text.split("\n").entries()) {
    const number = index + 1;
    const where = `${displayName(site)}:${number}`;
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
async function resolveLink(path: string, site: string): Promise<string> {
  let target: string;
  try {
    target = await fs.readlink(path);
  } catch (cause) {
    throw new ConfigError(
      `cannot read ${displayName(site)}: ${describeCause(cause)}`,
    );
  }
  const joined = target.startsWith("/")
    ? target
    : `${dirNameOf(path)}/${target}`;
  const normalized = normalizePath(joined);
  // The deepest existing ancestor is resolved, not just the immediate parent.
  // A dangling target's parent does not exist, and the link above it may sit
  // on a symlinked path — a root reached through a link spells the same place
  // two different ways, and the boundary check below compares resolved text.
  // Resolving as far up as anything exists brings both spellings to one; the
  // components that do not exist are kept, so the resolved text still names
  // the same target the link names.
  const { prefix, suffix } = await deepestExistingPrefix(dirNameOf(normalized));
  if (prefix === null) return normalized;
  const tail = [suffix, baseNameOf(normalized)].filter((part) => part !== "");
  return [prefix, ...tail].join("/");
}

/**
 * The realpath of `path` or of its nearest existing ancestor, with the
 * components that do not exist kept beside it.
 *
 * `realpath` answers nothing for a path that does not exist. Asked for the
 * deepest ancestor that does exist instead, a dangling target still gets its
 * resolvable prefix spelled the way the boundary below is spelled, and the
 * unresolvable tail stays attached so the answer names the same place.
 */
async function deepestExistingPrefix(
  path: string,
): Promise<{ prefix: string | null; suffix: string }> {
  let candidate = path;
  const missing: string[] = [];
  while (true) {
    const real = await realPathOrNull(candidate);
    if (real !== null) {
      return {
        prefix: real,
        suffix: [...missing].reverse().join("/"),
      };
    }
    const parent = dirNameOf(candidate);
    if (parent === candidate) {
      return { prefix: null, suffix: missing.join("/") };
    }
    missing.push(baseNameOf(candidate));
    candidate = parent;
  }
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
  const resolved = await resolveLink(path, relative);
  if (resolved === boundary || resolved.startsWith(`${boundary}/`)) return [];
  return [
    `symlink-escape: ${displayName(relative)}: symlink resolves outside the skill directory`,
  ];
}

async function lintInto(
  root: string,
  dir: string,
  relative: string,
  violations: string[],
): Promise<void> {
  for (const entry of await readEntries(dir, relative)) {
    const path = `${dir}/${entry.name}`;
    const site = `${relative}/${entry.name}`;
    if (entry.isSymlink) {
      violations.push(...(await symlinkViolations(root, path, site)));
      continue;
    }
    if (entry.isDirectory) {
      await lintInto(root, path, site, violations);
    } else if (!entry.isRegularFile) {
      // Scanned by reading every byte, so an entry that is not a file the run
      // can read is refused rather than scanned. Reading a named pipe blocks
      // until a writer appears, and the linter would never come back.
      throw new ConfigError(`${site}: not a regular file`);
    } else {
      violations.push(
        ...lintLines(site, decodeForScan(await readBytes(path, site))),
      );
    }
  }
}

export async function commandLint(root: string, out: Sink): Promise<number> {
  await assertTreeRoot(root);
  const skillsDir = `${root}/${SKILLS_DIR}`;
  if (!(await isDirectoryOrAbsent(root, SKILLS_DIR))) {
    throw new ConfigError(`${SKILLS_DIR}/ does not exist under ${root}`);
  }
  const violations: string[] = [];
  await lintInto(root, skillsDir, SKILLS_DIR, violations);
  for (const violation of violations) out(violation);
  return violations.length > 0 ? 1 : 0;
}
