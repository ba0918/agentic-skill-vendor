#!/usr/bin/env node
// cli.ts — the entry point: arguments in, exit code out.
//
// Routing only. Every command lives in the module named after it, and this file
// does nothing but decide which one an invocation names. Logic placed here
// would be logic reachable only by assembling an argument list, which is the
// one shape none of the tests can drive directly.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ConfigError, describeCause, type Sink } from "./errors.ts";
import { commandGen } from "./gen.ts";
import { commandVerify } from "./verify.ts";
import { commandAccept } from "./accept.ts";
import { commandLint } from "./lint.ts";
import { commandSelfTest } from "./selftest.ts";

const USAGE = [
  "usage: agentic-skill-vendor <command> [--root <path>]",
  "",
  "commands:",
  "  gen                      write the accepted contracts into every skill",
  "  verify                   check the tree against the lock",
  "  accept <contract-id>...  adopt the current text of the named contracts",
  "  lint-selfcontain         check that no skill points outside itself",
  "  self-test                check the tool against its embedded vectors",
  "",
  "options:",
  "  --root <path>            the tree to work on (default: .)",
  "",
  "exit codes: 0 nothing to report, 1 violations listed on stdout,",
  "            2 a refusal or an internal error described on stderr",
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
      // An empty argument is what an unset shell variable expands to. Reduced
      // to "/" it would silently point the run at the file system root instead
      // of saying that no path was named.
      //
      // A value that opens with '-' is refused for the same reason: it is what
      // a forgotten path looks like, and swallowing the next flag as a
      // directory name turns `--root --help` into a run against a tree called
      // "--help". A real path spelled that way is still reachable as `./-name`.
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new ConfigError("--root needs a path");
      }
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
 * Refuses an argument the named command has no use for.
 *
 * Asked by each command that takes none, rather than once before the routing.
 * Answered ahead of it, `frobnicate stray` would be refused for the stray word
 * while the reason nothing can run is the command itself.
 *
 * Ignoring the word is what a wrong answer given confidently looks like:
 * `verify tree` — a forgotten `--root` — read as a plain `verify` of the
 * current directory and reported on a tree nobody asked about.
 */
function refuseOperands(operands: string[]): void {
  if (operands.length === 0) return;
  throw new ConfigError(`unexpected argument: ${operands[0]}\n${USAGE}`);
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
        refuseOperands(invocation.operands);
        return await commandGen(invocation.root, out);
      case "verify":
        refuseOperands(invocation.operands);
        return await commandVerify(invocation.root, out);
      case "accept":
        return await commandAccept(invocation.root, invocation.operands, out);
      case "lint-selfcontain":
        refuseOperands(invocation.operands);
        return await commandLint(invocation.root, out);
      case "self-test":
        refuseOperands(invocation.operands);
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
    // A non-ConfigError is a bug in the tool, not a state of the tree. Left
    // uncaught, the runtime prints the stack trace — absolute machine paths
    // included — and exits 1, which is defined as "violations listed", so CI
    // would misread a crash as findings. One line, on the same exit code as
    // the other refusals.
    err(`internal error: ${describeCause(error)}`);
    return 2;
  }
}

/**
 * True when this module is the program the runtime was started with.
 *
 * `import.meta.main` says it in one word, but Node only learned it in v24 and
 * this package supports Node 20. The started path is resolved through realpath
 * because an npm bin is installed as a symlink: run through npx the process
 * starts at `.bin/<name>` while this module's own URL names the file that link
 * points at, and comparing the two unresolved never matches.
 *
 * The arguments are passed in rather than read from `process` so the same
 * probe runs on a runtime with no `process` global at all — Deno, which this
 * package claims to support. Read directly, the global itself throws a
 * ReferenceError at module load there: the guard lives in the caller, which
 * hands a runtime with no argv an empty list.
 */
export function startedThisProgram(argv: string[]): boolean {
  const started = argv[1];
  if (started === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(started)).href;
  } catch {
    return false;
  }
}

// A runtime with no `process` global is asked whether this module was `main`,
// and the honest answer is "no": there is no started path to compare against.
// On a runtime that does have one, the probe is asked with its argv.
const argv = typeof process === "undefined" ? [] : process.argv;
if (startedThisProgram(argv)) {
  // The code is set rather than exited on, so anything already queued still
  // finishes: an exit here would cut off output that has been written but not
  // yet flushed.
  process.exitCode = await run(
    argv.slice(2),
    (line) => console.log(line),
    (line) => console.error(line),
  );
}
