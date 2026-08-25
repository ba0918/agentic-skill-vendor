#!/usr/bin/env node
// cli.ts — the package entrypoint: started program in, exit code out.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "./cli/run.ts";

export { run };

/**
 * True when this package entrypoint is the program the runtime started with.
 *
 * The started path is resolved through realpath because an npm bin is installed
 * as a symlink. Arguments are passed in so a runtime with no `process` global
 * can load the module and honestly answer that no program path was supplied.
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

const argv = typeof process === "undefined" ? [] : process.argv;
if (startedThisProgram(argv)) {
  // Set the code rather than exiting immediately so queued output can flush.
  process.exitCode = await run(
    argv.slice(2),
    (line) => console.log(line),
    (line) => console.error(line),
  );
}
