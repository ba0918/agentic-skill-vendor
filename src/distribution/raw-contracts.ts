import { ConfigError } from "../errors.ts";
import { compareStrings } from "../ordering.ts";
import { cacheRevisionDirOf } from "../contracts/cache.ts";
import type { LockSources, Resolution } from "../contracts/lock-model.ts";
import {
  LOCAL_SOURCE,
  type Declaration,
  type RawMapping,
} from "../contracts/sources.ts";
import {
  rawContractDigest,
  srcKeyOf,
  type RawMaterial,
} from "../contracts/raw.ts";
import {
  declaredIds,
  dependentIndex,
  type SkillDeclaration,
} from "../contracts/declaration.ts";
import { emptyRecord } from "../records.ts";
import {
  assertPlainChain,
  displayName,
  isDirectoryOrAbsent,
} from "../filesystem/walk.ts";
import { readRawMaterials } from "./rawsource.ts";

export interface MissingRemoteContracts {
  missing: string[];
  unpinned: string[];
}

/** Classifies absent remote material without deciding caller-specific wording. */
export function classifyMissingRemoteContracts(
  ids: string[],
  isMissing: (id: string) => boolean,
  sourceOf: (id: string) => string,
  sources: LockSources,
): MissingRemoteContracts {
  const missing = ids.filter(isMissing);
  return {
    missing,
    unpinned: missing.filter((id) => sources[sourceOf(id)] === undefined),
  };
}

/**
 * What one raw-byte contract's material is, and who answers for it.
 *
 * `materials` is null where the tree does not hold it: for a local contract a
 * closure gap, for a remote one a cache not yet fetched — a state a clean
 * checkout is in, which is why the two are told apart here.
 */
export interface RawReading {
  local: boolean;
  materials: RawMaterial[] | null;
  /** The first absent src in path order, where `materials` is null for that reason. */
  missing: string | null;
}

/** Every raw-byte contract a run has to look at, and what the tree holds for it. */
export type RawContracts = Map<string, RawReading>;

/** The ids the table declares as raw-byte contracts. */
export function rawMappingsOf(
  declaration: Declaration,
): Map<string, RawMapping[]> {
  const raw = new Map<string, RawMapping[]>();
  for (const id of Object.keys(declaration.contracts)) {
    const files = declaration.contracts[id].files;
    if (files !== undefined) raw.set(id, files);
  }
  return raw;
}

/**
 * Reads the canonical side of every raw-byte contract among `ids`: from
 * this tree for a local one, from the cache at the pinned commit for a
 * remote one. A remote contract whose source the lock pins no commit for,
 * or whose revision the cache does not hold, reads as not held.
 *
 * The tree's own ignore rules apply to local material only. For fetched
 * material the source repository's rules already decided what the listing
 * held, and this tree's rules exclude the whole cache on purpose.
 */
export async function readRawContracts(
  root: string,
  declaration: Declaration,
  sources: LockSources,
  ids: string[],
): Promise<RawContracts> {
  const mappings = rawMappingsOf(declaration);
  const contracts: RawContracts = new Map();
  for (const id of ids) {
    const rows = mappings.get(id);
    if (rows === undefined) continue;
    const source = declaration.contracts[id].source;
    if (source === LOCAL_SOURCE) {
      const read = await readRawMaterials(
        root,
        id,
        rows,
        true,
        declaration.ignore,
        declaration.contracts[id].ignore,
      );
      contracts.set(
        id,
        Array.isArray(read)
          ? { local: true, materials: read, missing: null }
          : { local: true, materials: null, missing: read.missing },
      );
      continue;
    }
    const pinned = sources[source];
    if (pinned === undefined) {
      contracts.set(id, { local: false, materials: null, missing: null });
      continue;
    }
    const revision = cacheRevisionDirOf(source, pinned.revision);
    await assertPlainChain(root, revision);
    if (!(await isDirectoryOrAbsent(root, revision))) {
      contracts.set(id, { local: false, materials: null, missing: null });
      continue;
    }
    const inCache = rows.map((mapping) => ({
      ...mapping,
      src: `${revision}/${mapping.src}`,
    }));
    const read = await readRawMaterials(
      root,
      id,
      inCache,
      false,
      declaration.ignore,
      declaration.contracts[id].ignore,
    );
    contracts.set(id, {
      local: false,
      // The src the material is framed under is the source's own path, not
      // the cache site it was read from: the cache is where the bytes sit,
      // not what the contract is.
      materials: Array.isArray(read)
        ? read.map((material, index) => ({ ...material, mapping: rows[index] }))
        : null,
      missing: null,
    });
  }
  return contracts;
}

/** The declared raw-byte contracts whose src the tree does not hold. */
export function rawClosureViolations(
  skills: SkillDeclaration[],
  raws: RawContracts,
): string[] {
  const violations: string[] = [];
  const dependentsOfId = dependentIndex(skills);
  for (const id of declaredIds(skills)) {
    const reading = raws.get(id);
    // A remote contract's missing material is a fetch away, not a closure
    // gap: a clean checkout is in that state.
    if (reading === undefined || reading.materials !== null || !reading.local)
      continue;
    const dependents = (dependentsOfId.get(id) ?? [])
      .map(displayName)
      .join(", ");
    violations.push(
      `closure: ${id} is declared by ${dependents} but ${reading.missing} ` +
        `does not exist`,
    );
  }
  return violations;
}

/** The resolution each raw-byte contract the tree holds renders to. */
export async function deriveRawResolutions(
  raws: RawContracts,
): Promise<Record<string, Resolution>> {
  const resolutions = emptyRecord<Resolution>();
  for (const id of [...raws.keys()].sort(compareStrings)) {
    const materials = raws.get(id)?.materials ?? null;
    if (materials === null) continue;
    resolutions[id] = {
      digest: await rawContractDigest(materials),
      kind: "raw",
    };
  }
  return resolutions;
}

/** True for an id the table or the lock knows as a raw-byte contract. */
export function isRawId(
  id: string,
  declaration: Declaration,
  resolutions: Record<string, Resolution>,
): boolean {
  return (
    declaration.contracts[id]?.files !== undefined ||
    resolutions[id]?.kind === "raw"
  );
}

/**
 * Refuses a table row whose kind disagrees with what the lock remembers the
 * contract as. Both directions: a raw-byte row over a document resolution,
 * and a document row over a raw-byte one. Silently taken, one kind's copies
 * would be left behind by the other kind's sweep. An id with no row is not
 * judged — that state is a closure gap, or a retirement.
 */
export function assertKindsAgree(
  declaration: Declaration,
  resolutions: Record<string, Resolution>,
): void {
  for (const id of Object.keys(declaration.contracts).sort(compareStrings)) {
    const resolution = resolutions[id];
    if (resolution === undefined) continue;
    const rowIsRaw = declaration.contracts[id].files !== undefined;
    const lockIsRaw = resolution.kind === "raw";
    if (rowIsRaw === lockIsRaw) continue;
    throw new ConfigError(
      `${id} is ${rowIsRaw ? "a raw-byte" : "a document"} contract in ` +
        `vendor-manifest.yaml but the lock resolves it as ` +
        `${lockIsRaw ? "raw-byte" : "a document"}; a contract cannot change ` +
        `kind in place — withdraw it from every skill, run gen, take the row ` +
        `out, run gen again, then write the new row`,
    );
  }
}

/**
 * What the lock records for each raw-byte contract this run read, against
 * what its src digests to now: the raw-byte half of the
 * lock-versus-canonical check. A contract the lock says nothing about is
 * unresolved; one it records another digest for is a stale lock.
 */
export function rawLockViolations(
  raws: RawContracts,
  recorded: Record<string, Resolution>,
  derived: Record<string, Resolution>,
): string[] {
  const violations: string[] = [];
  for (const id of [...raws.keys()].sort(compareStrings)) {
    const resolution = recorded[id];
    if (resolution === undefined) {
      violations.push(
        `unresolved: ${id} has no entry in vendor-lock.json; run gen to record one`,
      );
      continue;
    }
    const now = derived[id];
    // Material not held — a remote contract with no cache — is not compared:
    // the lock cannot be judged against files the tree does not have.
    if (now === undefined) continue;
    if (resolution.digest !== now.digest) {
      violations.push(
        `stale-lock: ${id} is recorded as ${resolution.digest} but its files ` +
          `digest to ${now.digest}; run gen to record the current files`,
      );
    }
  }
  return violations;
}

/**
 * Refuses a gen whose declared remote raw-byte contracts are not in the
 * cache, naming the one command that completes the tree — a fetch where the
 * lock pins a commit, an update where it pins none. The document-contract
 * refusal says the same about its own ids; the two are not folded because
 * the material they ask about is read by different modules.
 */
export function assertRawCacheHolds(
  skills: SkillDeclaration[],
  raws: RawContracts,
  declaration: Declaration,
  sources: LockSources,
): void {
  const sourceOf = (id: string) => declaration.contracts[id].source;
  const { missing, unpinned } = classifyMissingRemoteContracts(
    declaredIds(skills),
    (id) => {
      const reading = raws.get(id);
      return (
        reading !== undefined && !reading.local && reading.materials === null
      );
    },
    sourceOf,
    sources,
  );
  if (missing.length === 0) return;
  const named = (ids: string[]) =>
    ids.map((id) => `${id} (from ${sourceOf(id)})`).join(", ");
  if (unpinned.length > 0) {
    throw new ConfigError(
      `vendor-lock.json pins no commit for the source of ${named(unpinned)}; ` +
        `run update to resolve one`,
    );
  }
  throw new ConfigError(
    `the cache holds no files for ${named(missing)}; run fetch to put them back`,
  );
}

/** The raw-byte contracts the lock keeps a resolution for: local ones the tree holds, remote ones by their row. */
export function presentRawIds(raws: RawContracts): string[] {
  return [...raws.keys()].filter((id) => {
    const reading = raws.get(id) as RawReading;
    return !reading.local || reading.materials !== null;
  });
}

/** A document contract's conformance position inside the source that owns it. */
export interface ConformancePosition {
  source: string;
  directory: string;
}

/**
 * Refuses a raw-byte src that stands at, under or over the conformance
 * position of a document contract in the same source. Conformance tests are
 * collected by path prefix with no notion of which contract a file belongs
 * to, so a src over that position would distribute the tests and one under it
 * would be pinned as tests.
 */
export function assertSrcsClearOfConformance(
  declaration: Declaration,
  conformancePositions: Map<string, ConformancePosition>,
): void {
  for (const id of Object.keys(declaration.contracts).sort(compareStrings)) {
    const source = declaration.contracts[id].source;
    for (const mapping of declaration.contracts[id].files ?? []) {
      for (const [other, position] of conformancePositions) {
        if (source !== position.source) continue;
        const { directory } = position;
        if (
          mapping.src === directory ||
          mapping.src.startsWith(`${directory}/`) ||
          directory.startsWith(`${mapping.src}/`)
        ) {
          throw new ConfigError(
            `vendor-manifest.yaml: contracts.${id}.files names the src ` +
              `${JSON.stringify(srcKeyOf(mapping))}, which is at, under or ` +
              `over ${directory}, the conformance position of ${other}; ` +
              `tests are collected by prefix, so the two would be confused`,
          );
        }
      }
    }
  }
}
