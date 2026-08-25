import { compareStrings } from "../ordering.ts";
import { emptyRecord } from "../records.ts";
import { ConfigError, describeCause } from "../errors.ts";
import { decodeUtf8 } from "../filesystem/walk.ts";
import { assertValidContractId } from "./digest.ts";
import { classifyRepository } from "./repository.ts";
import {
  destsCollide,
  isTreeRelativePath,
  reservedDestRefusal,
} from "./source-schema.ts";
import type {
  LockSources,
  Placement,
  Placements,
  Resolution,
  Resolutions,
} from "./lock-model.ts";

const LOCK_FILE = "vendor-lock.json";
const DIGEST_FORM = /^sha256:[0-9a-f]{64}$/;
const SHA1_REVISION_FORM = /^[0-9a-f]{40}$/;
const SHA256_REVISION_FORM = /^[0-9a-f]{64}$/;

export interface DecodedLock {
  recordedSkills: ReadonlySet<string>;
  resolutions: Resolutions;
  placements: Placements;
  sources: LockSources;
}

export function emptyDecodedLock(): DecodedLock {
  return {
    recordedSkills: new Set(),
    resolutions: emptyRecord(),
    placements: emptyRecord(),
    sources: emptyRecord(),
  };
}

export function decodeLock(bytes: Uint8Array): DecodedLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, LOCK_FILE));
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `${LOCK_FILE}: not readable JSON: ${describeCause(cause)}`,
    );
  }
  const document = pickObject(parsed, "");
  const dependencies = document["dependencies"];
  if (dependencies === undefined)
    throw new ConfigError(`${LOCK_FILE}: has no dependencies key`);
  return {
    recordedSkills: new Set(
      Object.keys(pickObject(dependencies, "dependencies")),
    ),
    resolutions: validateResolutions(document),
    placements: validatePlacements(document),
    sources: validateSources(document),
  };
}

function validatePlacements(document: Record<string, unknown>): Placements {
  const raw = document["placements"];
  if (raw === undefined) return emptyRecord();
  const skills = pickObject(raw, "placements");
  const placements: Placements = emptyRecord();
  for (const skill of Object.keys(skills)) {
    if (!isPlainSkillName(skill))
      throw new ConfigError(
        `${LOCK_FILE}: placements names a skill that is not one directory name: ${JSON.stringify(skill)}`,
      );
    const dests = pickObject(skills[skill], `placements.${skill}`);
    const entries: Record<string, Placement> = emptyRecord();
    for (const dest of Object.keys(dests)) {
      const path = `placements.${skill}.${dest}`;
      const bare = dest.replace(/\/$/, "");
      if (!isTreeRelativePath(bare))
        throw new ConfigError(
          `${LOCK_FILE}: ${path} is not a path inside the skill`,
        );
      const reserved = reservedDestRefusal(bare);
      if (reserved !== null)
        throw new ConfigError(`${LOCK_FILE}: ${path} names ${reserved}`);
      for (const other of Object.keys(entries)) {
        if (destsCollide(other.replace(/\/$/, ""), bare))
          throw new ConfigError(
            `${LOCK_FILE}: ${path} is the same as or nests with placements.${skill}.${other}; two distributions cannot share a place`,
          );
      }
      const entry = pickObject(dests[dest], path);
      const contract = requireText(entry["contract"], `${path}.contract`);
      assertValidContractId(contract, `${LOCK_FILE}: ${path}.contract`);
      entries[dest] = {
        contract,
        src: requireText(entry["src"], `${path}.src`),
        digest: requireDigest(entry["digest"], `${path}.digest`),
      };
    }
    placements[skill] = entries;
  }
  return placements;
}

function validateSources(document: Record<string, unknown>): LockSources {
  const raw = document["sources"];
  if (raw === undefined) return emptyRecord();
  const entries = pickObject(raw, "sources");
  const sources: LockSources = emptyRecord();
  for (const name of Object.keys(entries)) {
    const entry = pickObject(entries[name], `sources.${name}`);
    const objectFormat = readObjectFormat(
      entry["objectFormat"],
      `sources.${name}.objectFormat`,
    );
    const repository = requireText(
      entry["repository"],
      `sources.${name}.repository`,
    );
    try {
      classifyRepository(repository);
    } catch (cause) {
      if (cause instanceof ConfigError)
        throw new ConfigError(
          `${LOCK_FILE}: sources.${name}.repository: ${cause.message}`,
        );
      throw cause;
    }
    sources[name] = {
      repository,
      revision: requireMatch(
        entry["revision"],
        objectFormat === "sha256" ? SHA256_REVISION_FORM : SHA1_REVISION_FORM,
        `sources.${name}.revision`,
        objectFormat === "sha256"
          ? "a 64-digit SHA-256 commit object id"
          : "a 40-digit SHA-1 commit object id",
      ),
      ...(objectFormat === undefined ? {} : { objectFormat }),
    };
  }
  return sources;
}

function validateResolutions(document: Record<string, unknown>): Resolutions {
  const raw = document["resolutions"];
  if (raw === undefined)
    throw new ConfigError(`${LOCK_FILE}: has no resolutions key`);
  const entries = pickObject(raw, "resolutions");
  const resolutions: Resolutions = emptyRecord();
  for (const id of Object.keys(entries)) {
    assertValidContractId(id, `${LOCK_FILE}: resolutions`);
    const entry = pickObject(entries[id], `resolutions.${id}`);
    const resolution: Resolution = {
      digest: requireDigest(entry["digest"], `resolutions.${id}.digest`),
    };
    if (entry["conformance"] !== undefined)
      resolution.conformance = requireDigest(
        entry["conformance"],
        `resolutions.${id}.conformance`,
      );
    if (entry["kind"] !== undefined) {
      if (entry["kind"] !== "raw")
        throw new ConfigError(
          `${LOCK_FILE}: resolutions.${id}.kind must be "raw" where present, found ${JSON.stringify(entry["kind"])}`,
        );
      resolution.kind = "raw";
    }
    resolutions[id] = resolution;
  }
  return resolutions;
}

function pickObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ConfigError(
      `${LOCK_FILE}: ${path || "document"} must be an object`,
    );
  return value as Record<string, unknown>;
}
function isPlainSkillName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}
function requireText(value: unknown, path: string): string {
  if (typeof value !== "string")
    throw new ConfigError(
      `${LOCK_FILE}: ${path} must be text, found ${JSON.stringify(value)}`,
    );
  return value;
}
function requireDigest(value: unknown, path: string): string {
  return requireMatch(value, DIGEST_FORM, path, "a sha256 digest");
}
function requireMatch(
  value: unknown,
  form: RegExp,
  path: string,
  wanted: string,
): string {
  if (typeof value !== "string" || !form.test(value))
    throw new ConfigError(
      `${LOCK_FILE}: ${path} must be ${wanted}, found ${JSON.stringify(value)}`,
    );
  return value;
}
function readObjectFormat(value: unknown, path: string): "sha256" | undefined {
  if (value === undefined) return undefined;
  if (value !== "sha256")
    throw new ConfigError(
      `${LOCK_FILE}: ${path} must be "sha256" when present, found ${JSON.stringify(value)}`,
    );
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(withSortedKeys(value), null, 2) + "\n";
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = emptyRecord();
  for (const key of Object.keys(source).sort(compareStrings)) {
    sorted[key] = withSortedKeys(source[key]);
  }
  return sorted;
}
