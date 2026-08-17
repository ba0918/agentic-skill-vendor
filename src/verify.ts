// verify.ts — deciding whether the tree is what was accepted.
//
// The four checks below do not depend on one another, and each is written so
// that it stays meaningful while the others are failing.

import type { Sink } from "./errors.ts";
import { compareStrings, digestOfBytes } from "./digest.ts";
import {
  assertTreeRoot,
  decodeUtf8,
  isRegularFileOrAbsent,
  readBytes,
} from "./walk.ts";
import { conformanceDigest } from "./conformance.ts";
import {
  declaredIds,
  dependenciesOf,
  readSkills,
  type SkillDeclaration,
} from "./declaration.ts";
import {
  buildManifest,
  canonicalJson,
  MANIFEST_FILE,
  presentContractIds,
  readLock,
  type Resolutions,
} from "./manifest.ts";
import {
  acceptanceViolations,
  listVendorEntries,
  readContracts,
  vendorDirOf,
  vendorHeader,
} from "./gen.ts";

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

async function copyViolations(
  root: string,
  skills: SkillDeclaration[],
  resolutions: Resolutions,
): Promise<string[]> {
  const encoder = new TextEncoder();
  const violations: string[] = [];
  for (const skill of skills) {
    const dir = vendorDirOf(skill.name);
    const accountedFor = new Set(skill.contracts.map((id) => `${id}.md`));
    // What the vendor directory holds is read before any copy inside it is
    // asked about. Asked the other way round, a tree where that path is not a
    // directory at all is refused for whichever copy happened to be looked up
    // first, naming a file below a directory that is not one.
    const present = await listVendorEntries(root, skill.name);
    for (const id of [...skill.contracts].sort(compareStrings)) {
      const resolution = resolutions[id];
      if (resolution === undefined) continue;
      const site = `${dir}/${id}.md`;
      if (!(await isRegularFileOrAbsent(root, site))) {
        violations.push(`drift: ${site} is missing`);
        continue;
      }
      const bytes = await readBytes(`${root}/${site}`, site);
      const header = encoder.encode(vendorHeader(id, resolution.digest));
      // Compared as bytes and never decoded, so a corrupted copy is drift
      // rather than an error about the tool's own input.
      if (!startsWith(bytes, header)) {
        violations.push(
          `drift: ${site} does not carry the header generated for ${resolution.digest}`,
        );
        continue;
      }
      // A view rather than a copy: the bytes up to the header are not needed
      // again, and the Web Crypto input is copied inside the digest anyway.
      const body = await digestOfBytes(bytes.subarray(header.length));
      if (body !== resolution.digest) {
        violations.push(
          `drift: ${site} holds text digesting to ${body}, the lock pins ${resolution.digest}`,
        );
      }
    }
    for (const name of present) {
      if (!accountedFor.has(name)) {
        violations.push(`extra: ${dir}/${name} answers to no declaration`);
      }
    }
  }
  return violations;
}

/**
 * Compares the manifest against what the declarations and the recorded
 * resolutions render to.
 *
 * The resolutions are carried across unchanged rather than recomputed, so a
 * divergence already reported as unaccepted drift or a conformance mismatch is
 * not reported a second time here as a stale manifest.
 */
async function manifestViolations(
  root: string,
  skills: SkillDeclaration[],
  resolutions: Resolutions,
): Promise<string[]> {
  if (!(await isRegularFileOrAbsent(root, MANIFEST_FILE))) {
    return [`manifest: ${MANIFEST_FILE} is missing`];
  }
  const expected = canonicalJson(
    buildManifest(
      dependenciesOf(skills),
      resolutions,
      await presentContractIds(root, resolutions),
    ),
  );
  const actual = decodeUtf8(
    await readBytes(`${root}/${MANIFEST_FILE}`, MANIFEST_FILE),
    MANIFEST_FILE,
  );
  if (actual === expected) return [];
  return [
    `manifest: ${MANIFEST_FILE} differs from what the declarations and the lock render to`,
  ];
}

/**
 * Compares each contract's conformance tree against the digest that was
 * accepted for it. The wording states the two values and does not claim which
 * of them moved: this tool cannot tell an edited test from a stale lock.
 */
async function conformanceViolations(
  root: string,
  resolutions: Resolutions,
): Promise<string[]> {
  const violations: string[] = [];
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    const current = await conformanceDigest(root, id);
    const locked = resolutions[id].conformance ?? null;
    if (current === locked) continue;
    violations.push(
      `conformance-mismatch: ${id} now has ${
        current ?? "no conformance tests"
      }` + `, the lock records ${locked ?? "none"}`,
    );
  }
  return violations;
}

/**
 * Four checks that do not depend on one another: what was accepted against the
 * canonical text, the copies against the pin, the manifest against what the
 * tree renders to, and each conformance tree against the digest accepted for
 * it. Keeping them separate is what lets any one of them stay meaningful while
 * another is failing.
 */
export async function commandVerify(root: string, out: Sink): Promise<number> {
  await assertTreeRoot(root);
  const { recordedSkills, resolutions } = await readLock(root);
  const skills = await readSkills(root, recordedSkills);
  const contracts = await readContracts(root, declaredIds(skills));

  // The three file-system checks are independent of one another and of the
  // acceptance check, so they overlap; their findings are reported in the
  // same order a serial run would have produced them in, and a refusal names
  // the first failing check in that fixed order rather than whichever
  // settled first.
  const settled = await Promise.allSettled([
    copyViolations(root, skills, resolutions),
    manifestViolations(root, skills, resolutions),
    conformanceViolations(root, resolutions),
  ]);
  const violations = [...acceptanceViolations(skills, contracts, resolutions)];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      violations.push(...result.value);
      continue;
    }
    throw result.reason;
  }
  for (const violation of violations) out(violation);
  return violations.length > 0 ? 1 : 0;
}
