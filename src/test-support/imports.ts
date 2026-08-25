import * as fs from "node:fs/promises";
import { posix } from "node:path";

/**
 * Every module of this package `entry` reaches, `entry` itself included.
 *
 * What a case built on this states is a boundary — which code an entry point
 * is built on — and the answer has to come from the imports rather than from a
 * list beside them: a list stays true only until the import it should have
 * caught is written, at which point it names one module too few and says
 * nothing at all.
 *
 * The names are read out of the source text rather than imported, so a
 * `import type` edge counts as much as a value one. It is stricter than what
 * the runtime does — a type-only import loads nothing — and deliberately so:
 * an entry point naming the network layer at all is the change worth seeing,
 * whatever the runtime then does with the name.
 */
export async function importClosureOf(entry: string): Promise<Set<string>> {
  const reached = new Set<string>();
  const pending = [entry];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    const source = await fs.readFile(
      new URL(`../${name}`, import.meta.url),
      "utf8",
    );
    for (const match of source.matchAll(/from "(\.{1,2}\/[^"']+\.ts)"/g)) {
      pending.push(posix.normalize(posix.join(posix.dirname(name), match[1])));
    }
  }
  return reached;
}
