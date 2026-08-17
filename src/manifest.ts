// manifest.ts — the lock and the provenance record, in one canonical form.
//
// Verify compares the manifest byte for byte, so "the manifest is up to date"
// has to be a decidable question rather than a question about JSON formatting.
// One rendering, stated here, is what makes it decidable.

import * as fs from "node:fs/promises";
import packageManifest from "../package.json" with { type: "json" };
import { ConfigError, describeCause } from "./errors.ts";
import {
  assertValidContractId,
  compareStrings,
  contractPath,
} from "./digest.ts";
import { assertPlainContractPaths } from "./conformance.ts";
import {
  assertPlainChain,
  decodeUtf8,
  isNotFound,
  isRegularFileOrAbsent,
} from "./walk.ts";
import type { Dependencies } from "./declaration.ts";

/** The one file the lock and the provenance record live in. */
export const MANIFEST_FILE = "vendor-manifest.json";
const DIGEST_FORM = /^sha256:[0-9a-f]{64}$/;

/**
 * What generated the artifacts, recorded in provenance and in every vendored
 * copy's header.
 *
 * The name is frozen at `agentic-skill-vendor` from here on. It is a value on
 * the wire, not a path: it sits in bytes that verify compares exactly, so
 * changing it reports every already generated copy in every consuming
 * repository as drift. It was `vendor.ts` — the name of the single file the
 * tool used to be — and moving it to the published name is the last time it
 * may move, taken while no version has been released and no copy exists to
 * break.
 *
 * The version is the package's own, read from the one place it is written.
 * Kept as a second literal it would be a number that means nothing: it stood
 * at 1.0.0 while the package stood at 0.1.0, so provenance named a release
 * that had never happened. A JSON import is what carries this identically on
 * every runtime — the bundler inlines it, so the published artifact holds the
 * value rather than a read that would have to find the file again.
 */
export const GENERATOR = {
  name: "agentic-skill-vendor",
  version: packageManifest.version,
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
 *
 * The ids come from the lock rather than from any declaration, so this is the
 * one route to contracts/ a tree whose skills declare nothing still takes. The
 * link check therefore belongs here too: without it such a tree would record
 * provenance for files sitting outside the boundary the run was pointed at.
 *
 * The conformance tests beside the text are covered by the same check, on the
 * same grounds: whether a link is refused is a fact about the tree, not about
 * which command is looking. A contract only the lock still names is reached
 * through here and nowhere else, so left out here that shape stopped verify,
 * which digests those tests, while gen and accept carried on.
 */
export async function presentContractIds(
  root: string,
  resolutions: Resolutions,
): Promise<string[]> {
  const present: string[] = [];
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    const site = contractPath(id);
    await assertPlainContractPaths(root, id);
    if (await isRegularFileOrAbsent(root, site)) present.push(id);
  }
  return present;
}

/** The resolutions currently recorded, or none when there is no manifest yet. */
export async function readResolutions(root: string): Promise<Resolutions> {
  await assertPlainChain(root, MANIFEST_FILE);
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(`${root}/${MANIFEST_FILE}`);
  } catch (cause) {
    if (isNotFound(cause)) return {};
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
