// verify.ts — deciding whether the tree agrees with its lock.
//
// The four checks below do not depend on one another, and each is written so
// that it stays meaningful while the others are failing.

import type { Sink } from "./errors.ts";
import { compareStrings, digestOfBytes } from "./digest.ts";
import {
  decodeUtf8,
  displayName,
  isRegularFileOrAbsent,
  readBytes,
} from "./walk.ts";
import { conformanceDigest } from "./conformance.ts";
import type { SkillDeclaration } from "./declaration.ts";
import {
  LOCK_FILE,
  type LockSources,
  type Placements,
  renderExpectedLock,
  type Resolutions,
  sourceViolations,
} from "./manifest.ts";
import {
  closureViolations,
  listVendorEntries,
  locateTreeContracts,
  lockViolations,
  readContracts,
  readTreeState,
  vendorDirOf,
  vendorHeader,
} from "./gen.ts";
import type { ContractLocation, Declaration } from "./sources.ts";
import {
  assertKindsAgree,
  deriveRawResolutions,
  isRawId,
  placementViolations,
  rawClosureViolations,
  rawLockViolations,
  readRawContracts,
} from "./placements.ts";
import { declaredIds } from "./declaration.ts";

/**
 * True when `bytes` opens with `prefix`. Local to this one comparison: the
 * only raw byte-prefix match the tool makes, so it is kept beside its sole
 * caller rather than lifted to walk.ts beside the other byte primitives.
 */
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
  declaration: Declaration,
): Promise<string[]> {
  const encoder = new TextEncoder();
  const violations: string[] = [];
  for (const skill of skills) {
    const dir = vendorDirOf(skill.name);
    // A raw-byte contract lands where the table says, never here; the
    // placements check answers for it.
    const documents = skill.contracts.filter(
      (id) => !isRawId(id, declaration, resolutions),
    );
    const accountedFor = new Set(documents.map((id) => `${id}.md`));
    // What the vendor directory holds is read before any copy inside it is
    // asked about. Asked the other way round, a tree where that path is not a
    // directory at all is refused for whichever copy happened to be looked up
    // first, naming a file below a directory that is not one.
    const present = await listVendorEntries(root, skill.name);
    for (const id of [...documents].sort(compareStrings)) {
      const resolution = resolutions[id];
      if (resolution === undefined) continue;
      const site = `${dir}/${id}.md`;
      if (!(await isRegularFileOrAbsent(root, site))) {
        violations.push(`drift: ${displayName(site)} is missing`);
        continue;
      }
      const bytes = await readBytes(`${root}/${site}`, site);
      const header = encoder.encode(vendorHeader(id, resolution.digest));
      // Compared as bytes and never decoded, so a corrupted copy is drift
      // rather than an error about the tool's own input.
      if (!startsWith(bytes, header)) {
        violations.push(
          `drift: ${displayName(site)} does not carry the header generated for ${resolution.digest}`,
        );
        continue;
      }
      // A view rather than a copy: the bytes up to the header are not needed
      // again, and the Web Crypto input is copied inside the digest anyway.
      const body = await digestOfBytes(bytes.subarray(header.length));
      if (body !== resolution.digest) {
        violations.push(
          `drift: ${displayName(site)} holds text digesting to ${body}, the lock pins ${resolution.digest}`,
        );
      }
    }
    for (const name of present) {
      if (!accountedFor.has(name)) {
        violations.push(
          `extra: ${displayName(`${dir}/${name}`)} answers to no declaration`,
        );
      }
    }
  }
  return violations;
}

/**
 * Compares the lock file against what the declarations and the recorded
 * resolutions render to.
 *
 * The resolutions are carried across as the lock records them rather than
 * recomputed, so a divergence already reported as a stale lock or a conformance
 * mismatch is not reported a second time here as a badly rendered file.
 *
 * The repository each source is pinned to cannot be carried across the same
 * way — the rendering takes it from the declaration, which is the authority
 * over it — so a lock naming another repository differs from the rendering by
 * construction. That one cause gets one finding: the source is named, and the
 * whole-file comparison stays silent for the run. Reported as well, it would
 * send a reader to the shape of the file while what is wrong is which
 * repository it names, and the update that resolves the one rewrites the whole
 * file through this same rendering, so nothing that comparison could have said
 * survives the remedy.
 *
 * The finding is `lock`, not `manifest`. The word manifest now names the
 * declaration file — `vendor-manifest.yaml`, written by hand — and a finding
 * carrying it would send a reader to the file this check never opens.
 */
async function lockFileViolations(
  root: string,
  skills: SkillDeclaration[],
  resolutions: Resolutions,
  sources: LockSources,
  locations: Map<string, ContractLocation>,
  declaration: Declaration,
  placements: Placements,
): Promise<string[]> {
  if (!(await isRegularFileOrAbsent(root, LOCK_FILE))) {
    return [`lock: ${LOCK_FILE} is missing`];
  }
  const divergent = sourceViolations(sources, declaration);
  if (divergent.length > 0) return divergent;
  const expected = await renderExpectedLock(
    root,
    skills,
    resolutions,
    sources,
    locations,
    declaration,
    placements,
  );
  const actual = decodeUtf8(
    await readBytes(`${root}/${LOCK_FILE}`, LOCK_FILE),
    LOCK_FILE,
  );
  if (actual === expected) return [];
  return [
    `lock: ${LOCK_FILE} differs from what the declarations and the lock render to`,
  ];
}

/**
 * Compares each contract's conformance tree against the digest the lock records
 * for it. The wording states the two values and does not claim which of them
 * moved: this tool cannot tell an edited test from a stale lock.
 */
async function conformanceViolations(
  root: string,
  resolutions: Resolutions,
  locations: Map<string, ContractLocation>,
): Promise<string[]> {
  const violations: string[] = [];
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    const location = locations.get(id);
    const site = location?.site ?? null;
    // The tests of a contract whose text this tree does not hold are not
    // compared: they are in the cache with the text, and a clean checkout has
    // neither. Silence is the honest answer — a finding here would report a
    // tree nobody changed as broken.
    if (site === null) continue;
    const current = await conformanceDigest(
      root,
      site,
      id,
      location?.local === true,
    );
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
 * Four checks that do not depend on one another: the lock against the canonical
 * text, the copies against the lock, the lock file against what the tree
 * renders to, and each conformance tree against the digest the lock records for
 * it.
 * Keeping them separate is what lets any one of them stay meaningful while
 * another is failing.
 */
export async function commandVerify(root: string, out: Sink): Promise<number> {
  const state = await readTreeState(root);
  const { resolutions, skills, sources } = state;
  assertKindsAgree(state.declaration, resolutions);
  const locations = await locateTreeContracts(root, state);
  const contracts = await readContracts(root, locations);
  const raws = await readRawContracts(
    root,
    state.declaration,
    declaredIds(skills),
  );

  // The three file-system checks are independent of one another and of the
  // check against the canonical text, so they overlap; their findings are
  // reported in the same order a serial run would have produced them in, and a
  // refusal names the first failing check in that fixed order rather than
  // whichever settled first.
  const settled = await Promise.allSettled([
    copyViolations(root, skills, resolutions, state.declaration),
    placementViolations(
      root,
      skills,
      state.declaration,
      state.placements,
      resolutions,
    ),
    lockFileViolations(
      root,
      skills,
      resolutions,
      sources,
      locations,
      state.declaration,
      state.placements,
    ),
    conformanceViolations(root, resolutions, locations),
  ]);
  const violations = [
    ...closureViolations(skills, contracts, locations),
    ...rawClosureViolations(skills, raws, state.declaration),
    ...lockViolations(skills, contracts, resolutions, locations),
    ...rawLockViolations(
      skills,
      raws,
      resolutions,
      await deriveRawResolutions(raws),
    ),
  ];
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
