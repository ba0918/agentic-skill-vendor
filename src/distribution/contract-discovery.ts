import {
  canonicalBody,
  CONTRACTS_DIR,
  digestOfText,
} from "../contracts/digest.ts";
import {
  assertPlainContractPaths,
  conformanceDirectory,
} from "../contracts/conformance.ts";
import { SKILLS_DIR } from "../contracts/declaration.ts";
import { cacheSiteOf } from "../contracts/cache.ts";
import type { LockSources } from "../contracts/lock-model.ts";
import {
  assertPlainChain,
  isDirectoryOrAbsent,
  isRegularFileOrAbsent,
  listEntries,
  readTextFile,
} from "../filesystem/walk.ts";
import {
  type ContractLocation,
  type Declaration,
  LOCAL_SOURCE,
  originPathOf,
  VENDOR_SUBPATH,
} from "../contracts/sources.ts";
import { rawMappingsOf, type ConformancePosition } from "./placements.ts";

/** Where each document contract keeps its conformance tests inside its source, by id. */
export function conformanceDirectoriesOf(
  locations: Map<string, ContractLocation>,
  declaration: Declaration,
): Map<string, ConformancePosition> {
  const positions = new Map<string, ConformancePosition>();
  for (const id of locations.keys()) {
    const origin = declaration.contracts[id];
    positions.set(id, {
      source: origin?.source ?? LOCAL_SOURCE,
      directory: conformanceDirectory(originPathOf(id, origin), id),
    });
  }
  return positions;
}
export function vendorDirOf(skill: string): string {
  return `${SKILLS_DIR}/${skill}/${VENDOR_SUBPATH}`;
}

/**
 * Reads each contract's canonical text, or null where the file is absent.
 *
 * The whole path is checked for links, not just the file at the end of it. A
 * link at `contracts/` makes every contract below it resolve outside the tree,
 * and the run would then digest outside text, pin it, and write it into every
 * vendored copy while reporting nothing — the escape this tool exists to close.
 *
 * The conformance tests beside the text are covered by the same check, although
 * nothing read here lies below their directory. That is the whole point of
 * asking it here: left to the commands that do read them, a link planted there
 * stopped verify while gen expanded the tree without a word.
 *
 * Null means the canonical file is not there at all, and nothing else. Anything
 * standing at the path that is not a file the run can read stops it instead:
 * carried as null it would be reported as a closure gap, which states that the
 * tree does not hold the text — a claim about the tree the run is in no
 * position to make. Keeping the two apart is also what leaves that report
 * truthful, since the only way left to reach it is a file genuinely absent.
 */
export async function readContracts(
  root: string,
  locations: Map<string, ContractLocation>,
): Promise<Map<string, CanonicalContract | null>> {
  const contracts = new Map<string, CanonicalContract | null>();
  if (locations.size === 0) return contracts;
  // A file standing at contracts/ made every contract below it read as "does
  // not exist" — the per-path lstat fails with ENOTDIR, which is not the
  // "nothing is there" this function answers with. Asked once, the fact is
  // named as what it is before any contract is looked up.
  await isDirectoryOrAbsent(root, CONTRACTS_DIR);
  for (const [id, location] of locations) {
    const site = location.site;
    if (site === null) {
      contracts.set(id, null);
      continue;
    }
    await assertPlainContractPaths(root, site, id);
    if (!(await isRegularFileOrAbsent(root, site))) {
      contracts.set(id, null);
      continue;
    }
    const text = await readTextFile(`${root}/${site}`, site);
    const body = canonicalBody(text, site);
    contracts.set(id, { digest: await digestOfText(body), body });
  }
  return contracts;
}

/**
 * Where this run reads each contract's canonical text.
 *
 * The declaration decides it, and the same answer serves the distribution, the
 * lock's rendering and every check — one place, because a run that read a
 * contract from one file while pinning what another file says is exactly the
 * drift this tool exists to make impossible.
 *
 * A contract no mapping names is local at the conventional position. That is
 * the shape of every repository that has never fetched anything, and it is why
 * an absent declaration changes nothing about how such a tree behaves.
 */
export async function locateContracts(
  root: string,
  declaration: Declaration,
  sources: LockSources,
  ids: string[],
): Promise<Map<string, ContractLocation>> {
  const locations = new Map<string, ContractLocation>();
  const raw = rawMappingsOf(declaration);
  for (const id of ids) {
    const origin = declaration.contracts[id];
    // A raw-byte contract has no single site: its material is read by the
    // placements module, and the lock's rendering asks that module whether
    // the tree holds it.
    if (raw.has(id)) continue;
    if (origin === undefined || origin.source === LOCAL_SOURCE) {
      locations.set(id, { local: true, site: originPathOf(id, origin) });
      continue;
    }
    // A remote contract is read out of the cache at the commit the lock pins,
    // and a cache that does not hold it yet is a state rather than a fault: a
    // clean checkout is in it. The commands part ways over what to do about
    // that, so what this answers is only whether the bytes are here.
    const pinned = sources[origin.source];
    if (pinned === undefined) {
      locations.set(id, { local: false, site: null });
      continue;
    }
    const site = cacheSiteOf(
      origin.source,
      pinned.revision,
      originPathOf(id, origin),
    );
    await assertPlainChain(root, site);
    locations.set(id, {
      local: false,
      site: (await isRegularFileOrAbsent(root, site)) ? site : null,
    });
  }
  return locations;
}

export interface CanonicalContract {
  digest: string;
  body: string;
}

/** The names directly inside a skill's vendor directory. */
export async function listVendorEntries(
  root: string,
  skill: string,
): Promise<string[]> {
  const relative = vendorDirOf(skill);
  await assertPlainChain(root, relative);
  if (!(await isDirectoryOrAbsent(root, relative))) return [];
  const dir = `${root}/${relative}`;
  return (await listEntries(dir, relative)).map((entry) => entry.name);
}
