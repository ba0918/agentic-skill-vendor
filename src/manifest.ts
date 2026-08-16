// manifest.ts — the lock and the provenance record, in one canonical form.
//
// Verify compares the manifest byte for byte, so "the manifest is up to date"
// has to be a decidable question rather than a question about JSON formatting.
// One rendering, stated here, is what makes it decidable.

import { ConfigError, describeCause } from "./errors.ts";
import {
  assertValidContractId,
  compareStrings,
  contractPath,
} from "./digest.ts";
import { assertPlainChain, decodeUtf8, isRegularFile } from "./walk.ts";
import type { Dependencies } from "./declaration.ts";

/** The one file the lock and the provenance record live in. */
export const MANIFEST_FILE = "vendor-manifest.json";
const DIGEST_FORM = /^sha256:[0-9a-f]{64}$/;

/**
 * What generated the artifacts, recorded in provenance and in every vendored
 * copy's header.
 *
 * The name stays `vendor.ts` although the tool is no longer one file of that
 * name. It is a value on the wire, not a path: it sits in bytes that verify
 * compares exactly, so changing it would report every already generated copy in
 * every consuming repository as drift.
 */
export const GENERATOR = {
  name: "vendor.ts",
  version: "1.0.0",
  source: "https://github.com/ba0918/agentic-skill-shared-reference-vendoring",
} as const;

export interface Resolution {
  digest: string;
  conformance?: string;
  version?: string;
}

export type Resolutions = Record<string, Resolution>;

/**
 * The manifest's canonical rendering: keys sorted at every level, two-space
 * indentation, one trailing newline, and no escaping of non-ASCII text.
 *
 * Verify compares the manifest byte for byte, so a canonical rendering is what
 * makes "the manifest is up to date" a decidable question rather than a
 * question about JSON formatting.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(withSortedKeys(value), null, 2) + "\n";
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareStrings)) {
    sorted[key] = withSortedKeys(source[key]);
  }
  return sorted;
}

/**
 * The manifest as the declarations, the resolutions and the present contracts
 * render to it.
 *
 * `present` names the contracts whose canonical file the tree actually holds,
 * and provenance is limited to those. A source path recorded for a contract
 * that has been withdrawn would name a file no reader can open, and provenance
 * exists to say where text came from — not where it used to.
 */
export function buildManifest(
  dependencies: Dependencies,
  resolutions: Resolutions,
  present: string[],
): unknown {
  const contracts: Record<string, { source: string }> = {};
  for (const id of [...present].sort(compareStrings)) {
    contracts[id] = { source: contractPath(id) };
  }
  // No wall-clock value is recorded anywhere in here. Reproducibility is the
  // reason this file exists, and a timestamp would make every regeneration a
  // change.
  return {
    lock: { dependencies, resolutions },
    provenance: { contracts, generator: { ...GENERATOR } },
  };
}

/**
 * The resolved contracts whose canonical file the tree holds.
 *
 * Every command that renders a manifest asks this one question through this one
 * function. Two commands answering it differently would make the manifest gen
 * writes differ from the manifest verify expects, and the difference would be
 * reported as a stale manifest that regenerating never fixes.
 */
export async function presentContractIds(
  root: string,
  resolutions: Resolutions,
): Promise<string[]> {
  const present: string[] = [];
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    if (await isRegularFile(`${root}/${contractPath(id)}`)) present.push(id);
  }
  return present;
}

/** The resolutions currently recorded, or none when there is no manifest yet. */
export async function readResolutions(root: string): Promise<Resolutions> {
  await assertPlainChain(root, MANIFEST_FILE);
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(`${root}/${MANIFEST_FILE}`);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return {};
    throw new ConfigError(
      `cannot read ${MANIFEST_FILE}: ${describeCause(cause)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, MANIFEST_FILE));
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `${MANIFEST_FILE}: not readable JSON: ${describeCause(cause)}`,
    );
  }
  return validateResolutions(parsed);
}

function validateResolutions(parsed: unknown): Resolutions {
  const lock = pickObject(pickObject(parsed, "")["lock"], "lock");
  const raw = lock["resolutions"];
  if (raw === undefined) return {};
  const entries = pickObject(raw, "lock.resolutions");
  const resolutions: Resolutions = {};
  for (const id of Object.keys(entries)) {
    assertValidContractId(id, `${MANIFEST_FILE}: lock.resolutions`);
    const entry = pickObject(entries[id], `lock.resolutions.${id}`);
    const resolution: Resolution = {
      digest: requireDigest(entry["digest"], `lock.resolutions.${id}.digest`),
    };
    if (entry["conformance"] !== undefined) {
      resolution.conformance = requireDigest(
        entry["conformance"],
        `lock.resolutions.${id}.conformance`,
      );
    }
    if (entry["version"] !== undefined) {
      if (typeof entry["version"] !== "string") {
        throw new ConfigError(
          `${MANIFEST_FILE}: lock.resolutions.${id}.version must be a string`,
        );
      }
      resolution.version = entry["version"];
    }
    resolutions[id] = resolution;
  }
  return resolutions;
}

function pickObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `${MANIFEST_FILE}: ${path || "document"} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !DIGEST_FORM.test(value)) {
    throw new ConfigError(
      `${MANIFEST_FILE}: ${path} must be a sha256 digest, found ${JSON.stringify(
        value,
      )}`,
    );
  }
  return value;
}
