// addcmd.ts — registering a source, and everything that follows from it.
//
// The command a person actually types. Everything else in this tool is
// maintenance of a table; this is the one entry point that puts a repository
// into it, and it does the whole of what registering implies rather than
// leaving a half-filled table behind: the ref is read from the repository and
// written down, the commit is resolved, the contracts already declared are
// mapped to it, and their text lands in the cache.

import { commandUpdate } from "./resolvecmd.ts";
import { ConfigError, type Sink } from "./errors.ts";
import type { GitHubClient } from "./github.ts";
import {
  assertRepository,
  assertSourceName,
  DECLARATION_FILE,
  parseDeclaration,
  readDeclaration,
  withSourceRegistration,
} from "./sources.ts";
import {
  atomicWriteFile,
  isRegularFileOrAbsent,
  readTextFile,
} from "./walk.ts";

/**
 * Registers `repository` as a source and does what update does afterwards.
 *
 * The ref is written down as the value the repository answered with, never
 * left implicit. A table that said nothing about the branch would resolve
 * against whatever the repository's default happened to be on the day it ran,
 * which is the moving target the lock exists to pin down.
 */
export async function commandAdd(
  root: string,
  out: Sink,
  client: GitHubClient,
  repository: string,
  named: string | undefined,
): Promise<number> {
  assertRepository(repository);
  const name = named ?? repository.split("/")[1];
  // Both checks run before anything is written, and that ordering is the whole
  // point of asking here at all: the schema refuses these values anyway, but
  // by then the table on disk would already carry them — a file this command
  // wrote and every later run stops on. A name the repository's own segment
  // cannot supply is asked for rather than rewritten into shape, since two
  // repositories quietly folded onto one name is worse than being asked.
  assertSourceName(name);
  const declaration = await readDeclaration(root);
  if (name in declaration.sources) {
    throw new ConfigError(
      `${DECLARATION_FILE} already registers a source called ${name}`,
    );
  }
  const ref = await client.defaultBranchOf(repository);
  const text = withSourceRegistration(await currentText(root), name, {
    repository,
    ref,
  });
  // The revised text is read back before it lands, the way gen and update read
  // theirs back. The scribe edits lines rather than rendering the document, so
  // the entry it writes carries this tool's own indentation into a table a
  // person may have written with some other — and a table that stopped being
  // readable YAML is not a run that failed but a file left behind: every later
  // verify, gen, update, fetch and add stops on it, with hand editing the only
  // way out. Refusing here costs the registration this run was asked for and
  // nothing else.
  parseDeclaration(text);
  await atomicWriteFile(root, DECLARATION_FILE, new TextEncoder().encode(text));
  return await commandUpdate(root, out, client);
}

/** The declaration as it stands, or an empty document where there is none. */
async function currentText(root: string): Promise<string> {
  if (!(await isRegularFileOrAbsent(root, DECLARATION_FILE))) return "";
  return await readTextFile(`${root}/${DECLARATION_FILE}`, DECLARATION_FILE);
}
