// cli.ts — the entry point: arguments in, exit code out.
//
// Routing only. Every command lives in the module named after it, and this file
// does nothing but decide which one an invocation names. Logic placed here
// would be logic reachable only by assembling an argument list, which is the
// one shape none of the tests can drive directly.

import { ConfigError, type Sink } from "./errors.ts";
import { commandGen } from "./gen.ts";
import { commandVerify } from "./verify.ts";
import { commandAccept } from "./accept.ts";
import { commandLint } from "./lint.ts";
import { commandSelfTest } from "./selftest.ts";

const USAGE = [
  "usage: cli.ts <command> [--root <path>]",
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
      // An empty argument is what an unset shell variable expands to. Reduced
      // to "/" it would silently point the run at the file system root instead
      // of saying that no path was named.
      if (value === undefined || value === "") {
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
