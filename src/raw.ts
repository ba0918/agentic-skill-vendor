// raw.ts — what a raw-byte contract digests to, and what each of its dests
// holds: pure, no file system.
//
// Two digests over the same files, framed the way a conformance tree is
// (`path NUL length NUL bytes`, in path order) and differing only in what the
// path is relative to. The contract's digest names files by their src path, so
// it says what the canonical side is and nothing about where copies land; a
// placement's digest names them relative to the dest, so a copy can be judged
// against it from the copy alone.

import { compareStrings, concatBytes, digestOfBytes } from "./digest.ts";
import type { RawMapping } from "./sources.ts";

/** One file of a raw-byte contract: where it sits relative to its src. */
export interface RawFile {
  /** "" for a file src; the path under the directory for a directory src. */
  relative: string;
  content: Uint8Array;
}

/** Every file one mapping carries, as the canonical side holds them. */
export interface RawMaterial {
  mapping: RawMapping;
  files: RawFile[];
}

/** The name a directory dest's marker file is written under. */
export const MARKER_FILE = ".vendored";

interface FramedEntry {
  path: string;
  content: Uint8Array;
}

/**
 * The framing every digest in this module and in conformance.ts shares. It is
 * external compatibility: a change here changes every recorded value.
 */
export async function framedDigest(entries: FramedEntry[]): Promise<string> {
  const ordered = [...entries].sort((a, b) => compareStrings(a.path, b.path));
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const entry of ordered) {
    chunks.push(encoder.encode(`${entry.path}\0${entry.content.length}\0`));
    chunks.push(entry.content);
  }
  return await digestOfBytes(concatBytes(chunks));
}

/** The path a file is framed under on the canonical side: its src path. */
function srcPathOf(material: RawMaterial, file: RawFile): string {
  return material.mapping.kind === "file"
    ? material.mapping.src
    : `${material.mapping.src}/${file.relative}`;
}

/** The path a file is framed under in a placement: relative to the dest. */
export function placedPathOf(mapping: RawMapping, file: RawFile): string {
  return mapping.kind === "file" ? basenameOf(mapping.dest) : file.relative;
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The contract's digest: every file of every mapping, named by src path. */
export async function rawContractDigest(
  materials: RawMaterial[],
): Promise<string> {
  const entries: FramedEntry[] = [];
  for (const material of materials) {
    for (const file of material.files) {
      entries.push({ path: srcPathOf(material, file), content: file.content });
    }
  }
  return await framedDigest(entries);
}

/** One placement's digest: the files of one mapping, named relative to the dest. */
export async function placementDigest(material: RawMaterial): Promise<string> {
  return await framedDigest(
    material.files.map((file) => ({
      path: placedPathOf(material.mapping, file),
      content: file.content,
    })),
  );
}

/** The dest as the lock keys it: with the kind marker back on. */
export function placementKeyOf(mapping: RawMapping): string {
  return mapping.kind === "directory" ? `${mapping.dest}/` : mapping.dest;
}

/** The src as the lock records it: with the kind marker back on. */
export function srcKeyOf(mapping: RawMapping): string {
  return mapping.kind === "directory" ? `${mapping.src}/` : mapping.src;
}
