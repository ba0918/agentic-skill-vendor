import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { ConfigError } from "./errors.ts";
import { canonicalBody, contractDigest, isValidContractId } from "./digest.ts";

Deno.test("the canonical body drops the frontmatter and the blank lines after it", () => {
  assertEquals(
    canonicalBody("---\nname: sample\n---\n\n\n# Title\n\nBody\n"),
    "# Title\n\nBody\n",
  );
});

Deno.test("a document without frontmatter is all body", () => {
  assertEquals(canonicalBody("# Title\n\nBody\n"), "# Title\n\nBody\n");
});

Deno.test("a body may open with a horizontal rule without losing it", () => {
  assertEquals(
    canonicalBody("---\nname: x\n---\n\n---\n\nBody\n"),
    "---\n\nBody\n",
  );
});

Deno.test("CRLF and LF endings digest as the same content", async () => {
  assertEquals(
    await contractDigest("Body line\r\nNext\r\n"),
    await contractDigest("Body line\nNext\n"),
  );
});

Deno.test("trailing newlines normalize to exactly one", async () => {
  assertEquals(
    await contractDigest("Body line\n\n\n"),
    await contractDigest("Body line\n"),
  );
});

Deno.test("a body with no trailing newline digests as one with a single newline", async () => {
  assertEquals(
    await contractDigest("Body line"),
    await contractDigest("Body line\n"),
  );
});

Deno.test("trailing whitespace inside a line is part of the content", async () => {
  assertNotEquals(
    await contractDigest("Body line  \n"),
    await contractDigest("Body line\n"),
  );
});

Deno.test("frontmatter opened but never closed is a configuration error", () => {
  assertThrows(
    () => canonicalBody("---\nname: sample\n\n# Title\n"),
    ConfigError,
  );
});

Deno.test("the contract digest matches its reference vector", async () => {
  // Hand-normalized to "Hello  \nWorld\n" and hashed with sha256sum, so the
  // expectation is independent of the normalizer it checks.
  assertEquals(
    await contractDigest(
      '---\r\nversion: "1"\r\n---\r\n\r\nHello  \r\nWorld\r\n\r\n\r\n',
    ),
    "sha256:f5755ff05efa18e544073833aa1963073a8eb5f80a817564228b5b44a27bd96a",
  );
});

Deno.test("the digest is rendered as a sha256 prefix and lowercase hex", async () => {
  const digest = await contractDigest("Body\n");
  assertEquals(/^sha256:[0-9a-f]{64}$/.test(digest), true, digest);
});

Deno.test("well-formed contract ids are accepted", () => {
  for (
    const id of [
      "verdict-format",
      "a",
      "log.v2",
      "x_1-y",
      "0start",
      "x".repeat(64),
    ]
  ) {
    assertEquals(isValidContractId(id), true, id);
  }
});

Deno.test("ids that could escape or break a path are rejected", () => {
  for (
    const id of [
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
    ]
  ) {
    assertEquals(isValidContractId(id), false, id);
  }
});
