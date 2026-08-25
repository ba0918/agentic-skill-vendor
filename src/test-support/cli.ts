import { run } from "../cli.ts";
import type { RemoteClient } from "../remote/remote.ts";

export interface CliResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

/**
 * Drives the CLI in process. The tool is reached through its exported entry
 * point rather than a subprocess so that the suite needs no run permission
 * beyond the read and write the tool itself asks for.
 *
 * The transport is handed in for the same reason: a case that drove the
 * fetching commands through the real one would be testing GitHub rather than
 * this tool, and the suite would need a network to pass. A case that names no
 * transport gets one that refuses every request, so a command that reached for
 * the network where it must not is a failure rather than a silent connection.
 */
export async function runCli(
  args: string[],
  transport: typeof fetch = refusingTransport,
  readStdin: () => string = refusingStdin,
  genericRemote: () => Promise<RemoteClient> = refusingGenericRemote,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    (line) => stdout.push(line),
    (line) => stderr.push(line),
    transport,
    readStdin,
    genericRemote,
  );
  return { code, stdout, stderr };
}

/**
 * Standard input, for a suite that must never touch the real one.
 *
 * A test runner's standard input is not a pipe carrying a credential, and a
 * case that reached for it would either block or read whatever the runner
 * happened to leave there. Refused, a command that read it where it must not
 * fails instead — the same shape as the transport above.
 */
const refusingStdin = (): string => {
  throw new Error("the test suite reads no standard input");
};

const refusingTransport = ((input: string | URL | Request) => {
  throw new Error(`the test suite reaches no network: ${String(input)}`);
}) as unknown as typeof fetch;

const refusingGenericRemote = (): Promise<RemoteClient> => {
  throw new Error("the test suite starts no Git subprocess");
};
