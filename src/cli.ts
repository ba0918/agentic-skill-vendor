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
import { commandAdd } from "./addcmd.ts";
import { commandGen } from "./distribution/gen.ts";
import { gitHubOver } from "./github.ts";
import { commandFetch, commandUpdate } from "./resolvecmd.ts";
import { commandVerify } from "./distribution/verify.ts";
import { readStandardInput, requireUsableToken } from "./token.ts";
import { commandLint } from "./distribution/lint.ts";
import { commandSelfTest } from "./selftest.ts";
import {
  type RemoteClient,
  type RemoteClientFactory,
  routedRemoteClient,
} from "./remote.ts";

const USAGE = [
  "usage: agentic-skill-vendor <command> [--root <path>]",
  "",
  "commands:",
  "  add <repository> [name]  register a source and take up what it holds",
  "  update                   move every pin to what its ref names now",
  "  fetch                    fill the cache with what the lock pins",
  "  gen                      write the current contract text into every skill",
  "  verify                   check the tree against the lock",
  "  lint-selfcontain         check that no skill points outside itself",
  "  self-test                check the tool against its embedded vectors",
  "",
  "options:",
  "  --root <path>            the tree to work on (default: .)",
  "  --token-stdin            read a GitHub token from standard input",
  "",
  "add, update and fetch are the commands that reach a network. gen, verify,",
  "lint-selfcontain and self-test read and write the tree and nothing else,",
  "and refuse --token-stdin for that reason.",
  "",
  "  gh auth token | agentic-skill-vendor update --token-stdin",
  "",
  "exit codes: 0 nothing to report, 1 violations listed on stdout,",
  "            2 a refusal or an internal error described on stderr",
].join("\n");

interface Invocation {
  command: string;
  root: string;
  operands: string[];
  tokenStdin: boolean;
}

function parseArguments(argv: string[]): Invocation | "help" {
  let root = ".";
  let command: string | null = null;
  let tokenStdin = false;
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
    } else if (token === "--token-stdin") {
      // A flag rather than a value: the credential itself never appears in an
      // argument list, where it would stand in the process listing for the
      // length of the run and in the shell history for good.
      tokenStdin = true;
    } else if (token.startsWith("-")) {
      throw new ConfigError(`unknown option: ${token}\n${USAGE}`);
    } else if (command === null) {
      command = token;
    } else {
      operands.push(token);
    }
  }
  if (command === null) throw new ConfigError(`no command given\n${USAGE}`);
  return { command, root, operands, tokenStdin };
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
 * Refuses `--token-stdin` where the command it was given to reaches no
 * network.
 *
 * A credential is a statement about a request, and gen, verify,
 * lint-selfcontain and self-test make none. Taken quietly, the flag would say
 * that these commands can be authenticated — which is the boundary this tool
 * states about them, that they read and write the tree and nothing else,
 * contradicted in the one place a person would look to check it. Standard
 * input is not read either: the refusal comes first, so a pipeline feeding a
 * mistyped command keeps whatever it was carrying.
 */
function refuseToken(command: string, tokenStdin: boolean): void {
  if (!tokenStdin) return;
  throw new ConfigError(
    `--token-stdin is not a flag ${command} takes: it reaches no network, ` +
      `and only add, update and fetch do\n${USAGE}`,
  );
}

/**
 * The repository `add` was pointed at, and a refusal where it was pointed at
 * nothing.
 *
 * The counterpart of refuseOperands for the one command that takes arguments:
 * an argument list is as much a part of the contract as a flag, and a run that
 * carried on with nothing named would ask the network about an empty string.
 */
function requireRepository(operands: string[]): string {
  if (operands.length === 0) {
    throw new ConfigError(`add needs a repository to register\n${USAGE}`);
  }
  if (operands.length > 2) {
    throw new ConfigError(`unexpected argument: ${operands[2]}\n${USAGE}`);
  }
  return operands[0];
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
  transport: typeof fetch = fetch,
  readStdin: () => string = readStandardInput,
  genericRemote: RemoteClientFactory = realGitRemote,
): Promise<number> {
  try {
    const invocation = parseArguments(argv);
    if (invocation === "help") {
      out(USAGE);
      return 0;
    }
    // Deferred until a GitHub source is actually selected: a generic-only run
    // must not consume a credential it cannot use. Memoized because a run may
    // route several sources through GitHub, while standard input can be read
    // only once. Validation still happens before the first request, so a value
    // that could put headers of its own into that request is stopped unsent.
    let tokenTaken = false;
    let token: string | undefined;
    const takeToken = (): string | undefined => {
      if (!tokenTaken) {
        tokenTaken = true;
        token = invocation.tokenStdin
          ? requireUsableToken(readStdin())
          : undefined;
      }
      return token;
    };
    switch (invocation.command) {
      case "add":
        requireRepository(invocation.operands);
        return await commandAdd(
          invocation.root,
          out,
          networkRemote(transport, takeToken, genericRemote),
          invocation.operands[0],
          invocation.operands[1],
        );
      case "update":
        refuseOperands(invocation.operands);
        return await commandUpdate(
          invocation.root,
          out,
          networkRemote(transport, takeToken, genericRemote),
        );
      case "fetch":
        refuseOperands(invocation.operands);
        return await commandFetch(
          invocation.root,
          out,
          networkRemote(transport, takeToken, genericRemote),
        );
      case "gen":
        refuseOperands(invocation.operands);
        refuseToken(invocation.command, invocation.tokenStdin);
        return await commandGen(invocation.root, out);
      case "verify":
        refuseOperands(invocation.operands);
        refuseToken(invocation.command, invocation.tokenStdin);
        return await commandVerify(invocation.root, out);
      case "lint-selfcontain":
        refuseOperands(invocation.operands);
        refuseToken(invocation.command, invocation.tokenStdin);
        return await commandLint(invocation.root, out);
      case "self-test":
        refuseOperands(invocation.operands);
        refuseToken(invocation.command, invocation.tokenStdin);
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

function networkRemote(
  transport: typeof fetch,
  takeToken: () => string | undefined,
  genericRemote: RemoteClientFactory,
): RemoteClient {
  return routedRemoteClient({
    github: async () => gitHubOver(transport, takeToken()),
    git: genericRemote,
  });
}

async function realGitRemote(): Promise<RemoteClient> {
  const [{ gitOver }, { createGitProcessRunner }] = await Promise.all([
    import("./git.ts"),
    import("./gitprocess.ts"),
  ]);
  return gitOver(createGitProcessRunner(), { interactive: false });
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
