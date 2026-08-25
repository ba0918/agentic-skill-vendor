import { expect, test } from "bun:test";
import { ConfigError } from "../errors.ts";
import { readStandardInput, requireUsableToken, TOKEN_LIMIT } from "./token.ts";

/** What the refusal says, for a case that must refuse. */
function refusalOf(raw: string): string {
  try {
    requireUsableToken(raw);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("the value was accepted");
}

test("the newline a pipe leaves behind is not part of the token", () => {
  // `gh auth token` and every other producer ends its output with a line
  // break. Carried into the header, the credential sent is one byte longer
  // than the one the person holds, and the host answers 401 to a token that
  // is not wrong.
  expect(requireUsableToken("ghp_0123456789abcdef\n")).toStrictEqual(
    "ghp_0123456789abcdef",
  );
  expect(requireUsableToken("github_pat_11ABCDE_xyz\r\n")).toStrictEqual(
    "github_pat_11ABCDE_xyz",
  );
});

test("whitespace other than one trailing line ending is refused", () => {
  for (const raw of [
    " ghp_value\n",
    "ghp_value \n",
    "\tghp_value\n",
    "\nghp_value\n",
    "ghp_value\n\n",
    "\uFEFFghp_value\n",
  ]) {
    expect(refusalOf(raw)).toContain("position");
  }
});

test("nothing on standard input is refused rather than sent as an empty credential", () => {
  // The shape a forgotten pipe makes: `--token-stdin` asked for, and the
  // producer that was to answer it never run. Sent as an empty Authorization
  // header, the run reaches the host as neither authenticated nor
  // unauthenticated, and reads the refusal that comes back as the source
  // having nothing.
  expect(refusalOf("")).toContain("nothing on standard input");
  expect(refusalOf("\r\n")).toContain("nothing on standard input");
});

test("a token carrying a line break is refused before it can become a header", () => {
  // Two lines piped in where one was meant. A header field is terminated by
  // CRLF, so a value carrying one does not travel as a value: everything past
  // the break is read by the host as the beginning of a header this tool
  // never wrote.
  expect(refusalOf("ghp_first\nX-Injected: yes")).toContain("position 10");
  expect(refusalOf("ghp_first\r\nX-Injected: yes")).toContain("position 10");
});

test("a token carrying anything but printable ASCII is refused", () => {
  // A credential is ASCII. Anything else is a file that was piped in by
  // mistake — and a NUL, a tab or a multi-byte character in a header field is
  // not a thing this tool can be sure any host reads the way it meant it.
  expect(refusalOf("ghp_ abc")).toContain("position 5");
  expect(refusalOf("ghp_\tabc")).toContain("position 5");
  expect(refusalOf("ghp_パスワード")).toContain("position 5");
});

test("a value too long to be a credential is refused rather than sent", () => {
  // The whole of some other file, piped in by a wrong redirect. Sent, it is a
  // request carrying whatever that file held to a host that never asked for
  // it.
  const accepted = "g".repeat(TOKEN_LIMIT);
  expect(requireUsableToken(accepted)).toStrictEqual(accepted);
  expect(refusalOf("g".repeat(TOKEN_LIMIT + 1))).toContain(
    `${TOKEN_LIMIT} characters`,
  );
});

test("no refusal repeats the value it refused", () => {
  // Every other refusal in this tool names the value it would not take, which
  // is what makes them readable. This one may not: its value is a credential,
  // and the places a refusal goes — a terminal, a CI log, an issue somebody
  // pastes it into — are all places a credential must not reach. The position
  // is what a person needs to find the byte, and the position leaks nothing.
  const refusedValue = "test-only-private-value";
  for (const raw of [
    `${refusedValue}\nX-Injected: yes`,
    `${refusedValue} ${refusedValue}`,
    `${refusedValue}${"g".repeat(TOKEN_LIMIT)}`,
  ]) {
    const refusal = refusalOf(raw);
    expect(refusal).not.toContain(refusedValue);
    expect(refusal).not.toContain("private-value");
  }
});

test("ordinary printable token values are taken as they are", () => {
  for (const token of [
    "test-classic-token-0123456789abcdef",
    "test-fine-grained-token_ABCDEF0123456789",
    "test-oauth-token-0123456789abcdef",
    "test-versioned-token.0123456789abcdef",
  ]) {
    expect(requireUsableToken(`${token}\n`)).toStrictEqual(token);
  }
});

test("standard input stops being read once no accepted token can fit", () => {
  const input = new TextEncoder().encode("g".repeat(TOKEN_LIMIT + 4096));
  let offset = 0;
  const reader = {
    isTerminal: () => false,
    read(into: Uint8Array): number {
      const count = Math.min(into.length, input.length - offset);
      into.set(input.subarray(offset, offset + count));
      offset += count;
      return count;
    },
  };

  expect(() => readStandardInput(reader)).toThrow(`${TOKEN_LIMIT} characters`);
  expect(offset).toBeLessThan(input.length);
});

test("terminal standard input is refused without reading from it", () => {
  let read = false;
  const reader = {
    isTerminal: () => true,
    read(): number {
      read = true;
      return 0;
    },
  };

  expect(() => readStandardInput(reader)).toThrow("terminal");
  expect(read).toStrictEqual(false);
});
