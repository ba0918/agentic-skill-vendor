// digest.ts — what a contract's text is, and what it digests to.
//
// Pure: no file system, no state, no dependency outside the standard runtime.
// Identity assurance is the tool's second responsibility, and everything that
// decides identity lives here, where a test can state a document and its digest
// side by side.

import { ConfigError } from "./errors.ts";

/** The prefix every digest this tool writes carries. */
export const DIGEST_PREFIX = "sha256:";
const CONTRACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const CONTRACT_ID_LIMIT = 64;
const FRONTMATTER_DELIMITER = "---";

/** Where a contract's canonical text lives, relative to the tree root. */
export const CONTRACTS_DIR = "contracts";

export function contractPath(id: string): string {
  return `${CONTRACTS_DIR}/${id}.md`;
}

/**
 * The order every canonical form in this tool is written in: by code unit,
 * never by locale. A locale-aware comparison would make the bytes a run writes
 * depend on the machine it ran on.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Document {
  frontmatter: string[];
  body: string;
}

/**
 * What the line shows a reader, with everything that draws as nothing removed.
 *
 * `trim` alone is not enough. It strips U+00A0 and U+FEFF, but a zero-width
 * space, a word joiner or a bidi mark survives it, and a delimiter carrying one
 * reads as ordinary text while looking exactly like a delimiter on screen.
 *
 * The removed set is named by the property Unicode gives it — the code points a
 * renderer is expected to show as nothing — rather than by a list of the ones
 * that have been run into. A list closes the holes someone thought of; the
 * property closes the class. The braille blank is added to it because it is the
 * exception the property does not cover: Unicode files it as a graphic
 * character, and it still draws as an empty cell.
 */
function visibleTextOf(line: string): string {
  return line.replace(/[\p{Default_Ignorable_Code_Point}\u2800]/gu, "").trim();
}

/** True for a line a reader would take for the delimiter, exact or not. */
function readsAsDelimiter(line: string): boolean {
  return visibleTextOf(line) === FRONTMATTER_DELIMITER;
}

/**
 * Splits a document into its frontmatter lines and its body. Blank lines
 * directly after the closing delimiter belong to the separator, not the body.
 *
 * An opening `---` with no closing `---` is an error rather than a document
 * that happens to have no frontmatter: reading it as all-body would silently
 * drop every declaration the unterminated block holds, and a pin that vanishes
 * quietly is the worst failure this tool can have.
 *
 * A first line that reads as the delimiter without being it exactly is refused
 * for the same reason. Trailing whitespace is invisible in an editor, survives
 * a copy-paste, and is tolerated by the frontmatter readers authors are used
 * to, so the block below it is believed to be live. The delimiter is matched
 * exactly rather than loosened because it also decides where a contract's
 * canonical body starts: accepting a second spelling of it would change what
 * an already pinned document digests to.
 *
 * A document that reaches the delimiter only after blank lines is refused for
 * the third time by the same argument. A horizontal rule at the very top of a
 * body separates nothing, so nothing legitimate is lost, whereas reading the
 * blank line as "this document has no frontmatter" would drop a live block.
 * The rule stays at the top of the document rather than refusing every `---`
 * further down, which would fire on the horizontal rules bodies legitimately
 * carry.
 */
export function splitDocument(text: string, site?: string): Document {
  const where = site ?? "document";
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    // The guard reads the document the way a person does: a lone carriage
    // return is a line break to every editor, so it breaks a line here too.
    // Only here. `canonicalBody` below keeps treating one as content, because
    // changing that would change what an already pinned document digests to.
    const shown = normalized.split(/\r|\n/);
    const opening = shown.findIndex((line) => visibleTextOf(line) !== "");
    if (opening !== -1 && readsAsDelimiter(shown[opening])) {
      throw new ConfigError(
        opening === 0
          ? `${where}: the line opening the frontmatter is not exactly '---': ${JSON.stringify(
              shown[0],
            )}`
          : `${where}: frontmatter has to open on the first line, and this ` +
              `document reaches '---' only below a blank one`,
      );
    }
    return { frontmatter: [], body: normalized };
  }
  // The closing scan keeps a lone `\r` within a line for the same reason the
  // body does. A line already split on `\n` can only contain a lone CR because
  // CRLF was normalized away, and treating that CR as a line break here while
  // keeping it as content in the body would pull the scanned boundary away
  // from the digest boundary. A document closed after a lone CR is refused
  // loudly instead — named as a missing closing line, never read as a silently
  // closed one.
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] !== FRONTMATTER_DELIMITER) {
      // The closing side is guarded the same way as the opening one. A line
      // that reads as the delimiter without being it exactly would otherwise
      // be skipped, and the scan would run on to the next exact `---` — a
      // horizontal rule in the body — pinning a truncated body as the
      // canonical text while gen and verify agree on the truncated value.
      if (readsAsDelimiter(lines[index])) {
        throw new ConfigError(
          `${where}: the line closing the frontmatter is not exactly '---': ${JSON.stringify(
            lines[index],
          )}`,
        );
      }
      continue;
    }
    let start = index + 1;
    while (start < lines.length && lines[start] === "") start++;
    return {
      frontmatter: lines.slice(1, index),
      body: lines.slice(start).join("\n"),
    };
  }
  throw new ConfigError(
    `${where}: frontmatter opens with '---' but the closing '---' line is missing`,
  );
}

/**
 * Frontmatter stripped, LF endings, exactly one trailing newline.
 *
 * Only line endings and the end of file are canonicalized. Whitespace at the
 * end of a line is content: in Markdown two trailing spaces are a hard line
 * break, so trimming per line would change what the document means.
 *
 * An empty body is canonicalized to a single newline, never to the empty
 * string: the digest contract reads "text ends in exactly one newline", and
 * the empty text does not. A genuinely empty contract is therefore pinned to
 * the one byte no editor renders, which is deliberate and consistent between
 * gen and verify.
 *
 * Exported for the test suite's assertions, which state a document and its
 * canonical form side by side — one implementation, so a change to the
 * normalization cannot silently diverge between the tool and its tests.
 */
export function canonicalBody(text: string, site?: string): string {
  return normalizeBody(splitDocument(text, site).body);
}

/**
 * One trailing newline on a body `splitDocument` already produced.
 *
 * Named apart from `canonicalBody` so the two steps of the canonical form —
 * dropping the frontmatter and fixing the trailing newline — read as two
 * steps.
 */
function normalizeBody(body: string): string {
  return body.replace(/\n+$/, "") + "\n";
}

/** One buffer holding these chunks end to end, in the order given. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * The lowercase hex form of a SHA-256 digest, without the `sha256:` prefix.
 *
 * Exported for the test suite's snapshot helpers, which describe file content
 * the same way this tool describes a digest — one implementation, so a change
 * to the algorithm cannot silently diverge between the tool and its tests.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copied rather than cast. Web Crypto asks for bytes backed by a plain
  // ArrayBuffer, while a file read hands back a view that may sit in the
  // runtime's shared pool, and the two are reconciled here by making one — an
  // assertion would silence the difference instead of resolving it.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Digest of exactly these bytes, in `sha256:<hex>` form. */
export async function digestOfBytes(bytes: Uint8Array): Promise<string> {
  return DIGEST_PREFIX + (await sha256Hex(bytes));
}

/** Digest of this text's UTF-8 bytes, with no canonicalization applied. */
export function digestOfText(text: string): Promise<string> {
  return digestOfBytes(new TextEncoder().encode(text));
}

/**
 * The git object id of these bytes: the SHA-1 of `blob <byte length>\0`
 * followed by the content, in lowercase hex.
 *
 * Not one of this tool's identity digests, and it must never be read as one.
 * Every digest above answers "is this the text the tree adopted", and this one
 * answers "are these the bytes the commit holds" — the acceptance test for a
 * download, computed the way the source's own listing computes it, so a
 * transfer can be judged without any comparison against the lock.
 *
 * SHA-1 is the algorithm because git's object id is a SHA-1 and nothing else
 * would match the listing. It is a hash chosen by the format being read rather
 * than by this tool, which is why it is used for detecting a corrupt transfer
 * and never for what the tool itself vouches for: an adversary who could pick
 * the bytes a source serves could already serve whatever they liked.
 *
 * The header counts bytes rather than characters, because that is what git
 * counts. Measured on the decoded text, every document holding a character
 * outside ASCII would be refused against a listing that is telling the truth.
 */
export async function gitObjectIdOf(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  // Copied for the reason sha256Hex copies: Web Crypto asks for bytes backed
  // by a plain ArrayBuffer, and a buffer read off a socket may not be.
  const object = new Uint8Array(concatBytes([header, bytes]));
  const digest = await crypto.subtle.digest("SHA-1", object);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Digest of a contract document's canonical body. */
export function contractDigest(text: string, site?: string): Promise<string> {
  return digestOfText(canonicalBody(text, site));
}

/** True when the id is safe to place in a path: an allowlist with no traversal. */
export function isValidContractId(id: string): boolean {
  // The pattern alone accepts `a..b`, because a dot is a legal character in the
  // middle of an id. The explicit `..` check is the part that rejects it, and
  // it rejects every embedded double dot rather than only `../`.
  return (
    id.length <= CONTRACT_ID_LIMIT &&
    !id.includes("..") &&
    CONTRACT_ID_PATTERN.test(id)
  );
}

export function assertValidContractId(id: string, site: string): void {
  if (!isValidContractId(id)) {
    throw new ConfigError(
      `${site}: not a usable contract id: ${JSON.stringify(id)}`,
    );
  }
}
