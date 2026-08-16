// vendor.ts — vendors shared reference documents into a skill repository.
//
// Run with `deno run --allow-read --allow-write vendor.ts <cmd>`. Read and
// write are the only permissions the tool asks for, and the dependencies it
// reaches for do not widen that: parsing text needs nothing from the network,
// the environment, or a subprocess.

import { parse as parseYaml } from "@std/yaml";
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
import {
  ancestorDirectories,
  IGNORE_FILE,
  joinRelative,
  readIgnoreRules,
  treeDirectoryOf,
} from "./ignore.ts";
import {
  conformanceDigest,
  conformanceDigestOfEntries,
} from "./conformance.ts";
import {
  declaredIds,
  dependenciesOf,
  dependentsOf,
  readSkills,
  type SkillDeclaration,
  skillFileOf,
  SKILLS_DIR,
} from "./declaration.ts";
import {
  buildManifest,
  canonicalJson,
  GENERATOR,
  MANIFEST_FILE,
  presentContractIds,
  readResolutions,
  type Resolution,
  type Resolutions,
} from "./manifest.ts";
import {
  acceptanceViolations,
  commandGen,
  executePlan,
  listVendorEntries,
  planExpansion,
  readContracts,
  renderVendorFile,
  vendorDirOf,
  vendorHeader,
} from "./gen.ts";
import { commandVerify } from "./verify.ts";
import { commandAccept } from "./accept.ts";

export * from "./walk.ts";
export * from "./ignore.ts";
export * from "./conformance.ts";
export * from "./declaration.ts";
export * from "./manifest.ts";
export * from "./gen.ts";
export * from "./verify.ts";
export * from "./accept.ts";
export { ConfigError };
export type { Sink };
export * from "./digest.ts";

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
