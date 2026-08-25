import { ConfigError } from "../errors.ts";
import { assertValidContractId } from "./digest.ts";
import {
  assertRepository,
  assertSourceName,
  isUsableRef,
} from "./source-schema.ts";
import {
  DECLARATION_FILE,
  LOCAL_SOURCE,
  type SourceRecord,
} from "./sources.ts";

// The writing half. Every change the tool makes to this file is a line
// inserted or a line taken out, never a re-rendering of the parsed document.
// Rendered whole, a run would delete the comments that record why a hand-
// written line is there — which is the only information in the file the tool
// cannot reconstruct.

const BLOCK_INDENT = "  ";
const ENTRY_INDENT = "    ";

/**
 * Refuses a ref the scribe is about to write into the table.
 *
 * The writing end asks a different question from the reading end: not "may
 * this value be believed" but "may this value be written down at all". Every
 * scalar below goes into the document unquoted, so one carrying a line break
 * writes lines of its own — a document that still parses, holding a key nobody
 * wrote — and one opening with a comment character writes a line with no value
 * on it. Neither reads back as what was handed in, and the file it leaves is
 * the tree's from then on.
 */
function assertWritableRef(ref: string): void {
  if (!isUsableRef(ref)) {
    throw new ConfigError(
      `${DECLARATION_FILE}: not a usable ref: ${JSON.stringify(ref)}`,
    );
  }
}

/**
 * Refuses a source name the scribe is about to write as the origin of a
 * contract.
 *
 * The name standing for this repository itself is the one value permitted here
 * and refused as a registration: `source: local` is exactly what a contract
 * this repository is the authority over is mapped to, while a *registered*
 * source of that name is what would make the mapping ambiguous.
 */
function assertWritableSource(source: string): void {
  if (source === LOCAL_SOURCE) return;
  assertSourceName(source);
}

/**
 * The text with `id` mapped to `source`, inserted at the end of the contracts
 * block.
 *
 * Appended rather than sorted into place. The order of this table is the
 * order a person chose, and a run that re-sorted it would put a diff nobody
 * asked for beside the one line it actually added.
 */
export function withContractMapping(
  text: string,
  id: string,
  source: string,
): string {
  assertValidContractId(id, `${DECLARATION_FILE}: contracts`);
  assertWritableSource(source);
  return withEntry(text, "contracts", id, [`${ENTRY_INDENT}source: ${source}`]);
}

/**
 * The text with `name` registered as a source, inserted at the end of the
 * sources block.
 */
export function withSourceRegistration(
  text: string,
  name: string,
  record: SourceRecord,
): string {
  assertSourceName(name);
  assertRepository(record.repository);
  assertWritableRef(record.ref);
  return withEntry(text, "sources", name, [
    `${ENTRY_INDENT}repository: ${record.repository}`,
    `${ENTRY_INDENT}ref: ${record.ref}`,
  ]);
}

/**
 * The text with `id` no longer mapped: the entry line and the lines indented
 * under it, and nothing else.
 *
 * A comment standing above the entry is left where it is. Whether it belonged
 * to the entry or introduced what follows it is a question only its author can
 * answer, and a scribe that guessed wrong would delete the record of a
 * decision while reporting that it pruned a mapping.
 */
export function withoutContractMapping(text: string, id: string): string {
  const { lines, ending } = documentLines(text);
  const opening = blockOpeningOf(lines, "contracts");
  if (opening === -1) return text;
  // The search stops where the block does. A source may be named after the
  // contract it holds, and a search that ran on would take that registration
  // out while the mapping it was asked to prune stayed where it was.
  const closing = blockEndOf(lines, opening);
  const entry = lines.findIndex(
    (line, index) =>
      index > opening && index < closing && isEntryOpening(line, id),
  );
  if (entry === -1) return text;
  let end = entry + 1;
  while (end < closing && lines[end].startsWith(ENTRY_INDENT)) end++;
  return [...lines.slice(0, entry), ...lines.slice(end), ""].join(ending);
}

/**
 * The document as lines, with the ending its lines are written with.
 *
 * The ending is carried rather than settled on. The scribe adds lines to a
 * file an editor keeps: lines of its own ending appended to a document written
 * with the other leave a file that still parses and no longer has one line
 * ending, and the next save of it rewrites every line — a whole-file diff
 * around the one line a run added, which is the same cost as re-rendering the
 * document.
 *
 * A document holding both endings is read as the one that is not bare, since
 * that is the ending something in the person's toolchain writes.
 */
function documentLines(text: string): { lines: string[]; ending: string } {
  return {
    lines: text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/),
    ending: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

/** True for the line that opens an entry of this name inside a block. */
function isEntryOpening(line: string, name: string): boolean {
  return new RegExp(
    `^${BLOCK_INDENT}${name.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}:\\s*(#.*)?$`,
  ).test(line);
}

/**
 * The text with an entry inserted at the end of the named top-level block,
 * creating the block where the document has none.
 */
function withEntry(
  text: string,
  block: string,
  name: string,
  body: string[],
): string {
  const { lines, ending } = documentLines(text);
  const entry = [`${BLOCK_INDENT}${name}:`, ...body];
  const opening = blockOpeningOf(lines, block);
  if (opening === -1) {
    // A blank line before a block the document did not have yet, unless the
    // document is empty or already ends in one: the file is read by people,
    // and two blocks running into each other read as one.
    const separator = lines.length > 0 && lines.at(-1) !== "" ? [""] : [];
    return [...lines, ...separator, `${block}:`, ...entry, ""].join(ending);
  }
  const inserted = insertionPointOf(lines, opening);
  return [
    ...lines.slice(0, inserted),
    ...entry,
    ...lines.slice(inserted),
    "",
  ].join(ending);
}

/** True for the line that opens a top-level block of this name. */
function isBlockOpening(line: string, block: string): boolean {
  return new RegExp(`^${block}:\\s*(#.*)?$`).test(line);
}

/** True for a top-level line that opens a key of this name, in any shape. */
function isBlockKey(line: string, block: string): boolean {
  return new RegExp(`^${block}:(\\s|$)`).test(line);
}

/**
 * Where the named block opens, -1 where the document holds no such key, and a
 * refusal where it holds one this scribe cannot edit.
 *
 * `contracts: {}` is a legal way to write the block, and a scribe that inserts
 * lines has nowhere to put one beneath it. Read as "the document has no such
 * block", the run opens a second one and leaves a document carrying the key
 * twice — which is exactly what this module's own reader refuses, so the file
 * a run had just written would stop every run after it.
 *
 * Rewriting the line into block form is the other way out, and it is refused
 * for what it costs: the flow form is a person's line, and a non-empty one
 * cannot be turned into a block without re-rendering the entries it holds —
 * the whole-document rewrite this half of the module exists to avoid.
 */
function blockOpeningOf(lines: string[], block: string): number {
  const opening = lines.findIndex((line) => isBlockOpening(line, block));
  if (opening !== -1) return opening;
  if (!lines.some((line) => isBlockKey(line, block))) return -1;
  throw new ConfigError(
    `${DECLARATION_FILE}: the ${block} block is written on one line, which ` +
      `leaves nowhere to add an entry under it; write ${block}: on a line of ` +
      `its own with each entry indented beneath it`,
  );
}

/**
 * The line the block ends before: the next top-level line, or the end.
 *
 * A comment is not a top-level line, wherever it starts. YAML gives a comment
 * no indentation to read, so one written at the left margin between two
 * entries stands inside the block as surely as an indented one — and read as
 * the end of it, every entry below stood outside the scribe's reach: the prune
 * left the line where it was and the insertion landed in the middle of the
 * table.
 */
function blockEndOf(lines: string[], opening: number): number {
  for (let index = opening + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trimStart().startsWith("#")) continue;
    if (line !== "" && !line.startsWith(" ")) return index;
  }
  return lines.length;
}

/**
 * Where a new entry goes: directly after the last line that belongs to an
 * entry of the block.
 *
 * Trailing blank lines and comments are left below the insertion rather than
 * above it. A comment written under the last entry is as likely to introduce
 * what comes next as to belong to what came before, and a blank line is a
 * separator a person put there — pushing both down keeps the file reading the
 * way it was written.
 */
function insertionPointOf(lines: string[], opening: number): number {
  const closing = blockEndOf(lines, opening);
  let point = opening + 1;
  for (let index = opening + 1; index < closing; index++) {
    const line = lines[index];
    if (line !== "" && !line.trimStart().startsWith("#")) point = index + 1;
  }
  return point;
}
