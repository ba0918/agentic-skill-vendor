import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import { canonicalBody, contractDigest, isValidContractId } from "./digest.ts";

test("the canonical body drops the frontmatter and the blank lines after it", () => {
  expect(
    canonicalBody("---\nname: sample\n---\n\n\n# Title\n\nBody\n"),
  ).toStrictEqual("# Title\n\nBody\n");
});

test("a document without frontmatter is all body", () => {
  expect(canonicalBody("# Title\n\nBody\n")).toStrictEqual("# Title\n\nBody\n");
});

test("a body may open with a horizontal rule without losing it", () => {
  expect(canonicalBody("---\nname: x\n---\n\n---\n\nBody\n")).toStrictEqual(
    "---\n\nBody\n",
  );
});

test("CRLF and LF endings digest as the same content", async () => {
  expect(await contractDigest("Body line\r\nNext\r\n")).toStrictEqual(
    await contractDigest("Body line\nNext\n"),
  );
});

test("trailing newlines normalize to exactly one", async () => {
  expect(await contractDigest("Body line\n\n\n")).toStrictEqual(
    await contractDigest("Body line\n"),
  );
});

test("a body with no trailing newline digests as one with a single newline", async () => {
  expect(await contractDigest("Body line")).toStrictEqual(
    await contractDigest("Body line\n"),
  );
});

test("trailing whitespace inside a line is part of the content", async () => {
  expect(await contractDigest("Body line  \n")).not.toStrictEqual(
    await contractDigest("Body line\n"),
  );
});

test("frontmatter opened but never closed is a configuration error", () => {
  expect(() => canonicalBody("---\nname: sample\n\n# Title\n")).toThrow(
    ConfigError,
  );
});

test("a closing delimiter with trailing whitespace is refused, never silently skipped", () => {
  // A closing `--- ` reads as the delimiter but is not one, exactly. Skipping
  // it would let the scan run on to the next exact `---` — a horizontal rule
  // in the body — and pin a truncated body as the canonical text.
  expect(() =>
    canonicalBody('---\nversion: "1"\n--- \nBody\n---\nmore\n'),
  ).toThrow(ConfigError);
});

test("the contract digest matches its reference vector", async () => {
  // Hand-normalized to "Hello  \nWorld\n" and hashed with sha256sum, so the
  // expectation is independent of the normalizer it checks.
  expect(
    await contractDigest(
      '---\r\nversion: "1"\r\n---\r\n\r\nHello  \r\nWorld\r\n\r\n\r\n',
    ),
  ).toStrictEqual(
    "sha256:f5755ff05efa18e544073833aa1963073a8eb5f80a817564228b5b44a27bd96a",
  );
});

test("a closing delimiter after a lone carriage return is refused loudly, never skipped", () => {
  // The body digest keeps a lone `\r` as content (it is a byte a document may
  // contain, and treating it as a line break would change what an already
  // pinned document digests to). The closing scan answers the same way: a line
  // bearing a lone CR before the delimiter is not read as a closing line. The
  // refusal is the honest answer either way — never a closed-looking document
  // silently misread — and it is named, not thrown away.
  expect(() => canonicalBody("---\nversion: 1\r---\nBody line\n")).toThrow(
    ConfigError,
  );
});

test("the digest is rendered as a sha256 prefix and lowercase hex", async () => {
  const digest = await contractDigest("Body\n");
  expect(/^sha256:[0-9a-f]{64}$/.test(digest), digest).toStrictEqual(true);
});

test("well-formed contract ids are accepted", () => {
  for (const id of [
    "verdict-format",
    "a",
    "log.v2",
    "x_1-y",
    "0start",
    "x".repeat(64),
  ]) {
    expect(isValidContractId(id), id).toStrictEqual(true);
  }
});

test("ids that could escape or break a path are rejected", () => {
  for (const id of [
    "",
    "..",
    "../evil",
    "a/b",
    "a\\b",
    "/absolute",
    "Upper",
    ".hidden",
    "-dash-start",
    "a..b",
    "a b",
    "a:b",
    "~home",
    "x".repeat(65),
  ]) {
    expect(isValidContractId(id), id).toStrictEqual(false);
  }
});
