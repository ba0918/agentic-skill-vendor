// token.ts — the credential, taken from standard input and judged before it
// can become a request header.
//
// Standard input rather than a file or an environment variable, and the choice
// is the whole point of this module. A file is a second copy of the secret at
// rest — one more thing to be committed, backed up, synced, or left readable
// by everything running as the same person — and making one safe would need a
// permission check that says nothing at all on a file system without POSIX
// modes. An environment variable is read by every child process and would cost
// this tool the one boundary it can still state plainly: that it reads none.
// A pipe leaves nothing behind, appears in no process listing and in no shell
// history, and needs no permission of its own on a runtime that asks for them
// — so the read-only commands' `--allow-read` stays exactly what it was.
//
// This tool never stores what it is handed here, and never writes it anywhere:
// the value lives in memory for the length of one run, reaches one header, and
// is named by no refusal.

import { readSync } from "node:fs";
import { isatty } from "node:tty";
import { ConfigError, describeCause } from "./errors.ts";

/**
 * The longest a credential may be.
 *
 * The token forms GitHub hands out are well under a hundred characters, so
 * this bounds nothing anybody legitimately pipes in. What it stops is the
 * other file — a redirect pointed at the wrong path, a whole document arriving
 * where a line was meant — becoming a request header carrying whatever that
 * file held to a host that never asked for it.
 */
export const TOKEN_LIMIT = 1024;

/**
 * The characters a credential may be spelled with: printable ASCII, no space.
 *
 * A header field is terminated by CRLF, so a value carrying a line break does
 * not travel as a value — everything past the break reaches the host as the
 * start of a header this tool never wrote. The rule is drawn wider than that
 * one character on purpose: a control character, a tab, or anything outside
 * ASCII is a file piped in by mistake rather than a credential, and guessing
 * at what a host makes of it is not a thing this tool needs to do.
 */
function unusableAt(token: string): number | null {
  for (let index = 0; index < token.length; index++) {
    const code = token.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return index;
  }
  return null;
}

/**
 * The token a run may send, from whatever arrived on standard input.
 *
 * No refusal here names the value it refused, which is the one way this
 * differs from every other refusal in the tool. A refusal is written to a
 * terminal, kept in a CI log and pasted into issues, and a credential must
 * reach none of those. The position is what a person needs in order to find
 * the character that stopped the run, and a position discloses nothing.
 */
export function requireUsableToken(raw: string): string {
  // The trailing line break every producer leaves is not part of the
  // credential: `gh auth token`, `op read` and a here-string all end their
  // output with one, and a header one byte longer than the token the person
  // holds is answered 401 by a host that would have accepted them.
  const token = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : raw;
  if (token === "") {
    throw new ConfigError(
      "--token-stdin was given but nothing on standard input: pipe a GitHub " +
        "token in, as in `gh auth token | agentic-skill-vendor update " +
        "--token-stdin`",
    );
  }
  if (token.length > TOKEN_LIMIT) {
    throw new ConfigError(
      `--token-stdin was given more than ${TOKEN_LIMIT} characters, which is ` +
        "longer than any credential GitHub hands out; check what is being " +
        "piped in",
    );
  }
  const unusable = unusableAt(token);
  if (unusable !== null) {
    throw new ConfigError(
      `--token-stdin was given a character this tool cannot put in a request ` +
        `header, at position ${unusable + 1}; a GitHub token is printable ` +
        `ASCII with no spaces, and the value itself is left out of this ` +
        `message on purpose`,
    );
  }
  return token;
}

/** Standard input, which every runtime this package supports names 0. */
const STDIN = 0;

export interface StandardInputReader {
  isTerminal(): boolean;
  read(into: Uint8Array): number;
}

const systemStandardInput: StandardInputReader = {
  isTerminal: () => isatty(STDIN),
  read: (into) => readSync(STDIN, into, 0, into.length, null),
};

/**
 * Whatever arrived on standard input, unjudged.
 *
 * Read only where `--token-stdin` was given, so a run that did not ask for a
 * credential never touches the stream at all — a command reading standard
 * input it was not asked to read would hang a pipeline that had other plans
 * for it.
 *
 * A terminal is refused rather than read. Read, the call would block until
 * somebody typed a credential and pressed the end-of-file key, which is a run
 * that has stopped with no output saying why — and the shape a forgotten pipe
 * actually takes.
 */
export function readStandardInput(
  reader: StandardInputReader = systemStandardInput,
): string {
  if (reader.isTerminal()) {
    throw new ConfigError(
      "--token-stdin was given but standard input is a terminal: pipe the " +
        "token in, as in `gh auth token | agentic-skill-vendor update " +
        "--token-stdin`",
    );
  }
  // The largest accepted token plus CRLF, and one byte that proves the input
  // cannot fit. Stop on that byte rather than draining a mistakenly piped
  // file into memory before reporting the limit.
  const bytes = new Uint8Array(TOKEN_LIMIT + 3);
  let length = 0;
  while (length < bytes.length) {
    let count: number;
    try {
      count = reader.read(bytes.subarray(length));
    } catch (cause) {
      // The cause is described rather than the value: a partial read would be
      // a fragment of a credential in an error message.
      throw new ConfigError(
        `--token-stdin was given but standard input could not be read: ${describeCause(cause)}`,
      );
    }
    if (count === 0) break;
    length += count;
    if (length > TOKEN_LIMIT + 2) {
      throw new ConfigError(
        `--token-stdin was given more than ${TOKEN_LIMIT} characters, which is ` +
          "longer than any credential GitHub hands out; check what is being " +
          "piped in",
      );
    }
  }
  return new TextDecoder().decode(bytes.subarray(0, length));
}
