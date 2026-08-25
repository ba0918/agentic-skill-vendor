import { ConfigError } from "../errors.ts";
import type { PlacedFile } from "../filesystem/atomic-write.ts";
import type { SkillDeclaration } from "../contracts/declaration.ts";
import type { ContractLocation, Declaration } from "../contracts/sources.ts";
import { LOCK_FILE, renderExpectedLock } from "../contracts/manifest.ts";
import type {
  LockSources,
  Placements,
  Resolutions,
} from "../contracts/lock-model.ts";
import { emptyRecord } from "../records.ts";
import {
  listVendorEntries,
  vendorDirOf,
  type CanonicalContract,
} from "./contract-discovery.ts";
import { presentRawIds, type RawContracts } from "./raw-contracts.ts";
import { planPlacements } from "./placement-plan.ts";
import { vendorHeader } from "./header.ts";

export function renderVendorFile(
  id: string,
  digest: string,
  body: string,
): string {
  return vendorHeader(id, digest) + body;
}

export interface WritePlan {
  files: { site: string; content: Uint8Array }[];
  placed: {
    site: string;
    what: { files: PlacedFile[] } | { content: Uint8Array };
  }[];
  sweeps: string[];
  lock: { site: string; content: Uint8Array };
  removals: string[];
  report: string[];
}

export async function planExpansion(
  root: string,
  skills: SkillDeclaration[],
  contracts: Map<string, CanonicalContract | null>,
  resolutions: Resolutions,
  sources: LockSources,
  locations: Map<string, ContractLocation>,
  declaration: Declaration,
  raws: RawContracts = new Map(),
  placements: Placements = emptyRecord(),
): Promise<WritePlan> {
  const encoder = new TextEncoder();
  const files: WritePlan["files"] = [];
  const placedDests: WritePlan["placed"] = [];
  const removals: string[] = [];
  const placed = await planPlacements(
    root,
    skills,
    raws,
    resolutions,
    placements,
  );
  placedDests.push(...placed.writes);
  for (const skill of skills) {
    const expected = new Set<string>();
    for (const id of skill.contracts) {
      if (raws.has(id)) continue;
      const contract = contracts.get(id);
      if (contract === undefined)
        throw new ConfigError(
          `cannot plan ${id}: its canonical text was never read`,
        );
      if (contract === null)
        throw new ConfigError(
          `cannot plan ${id}: its canonical text is absent`,
        );
      expected.add(`${id}.md`);
      files.push({
        site: `${vendorDirOf(skill.name)}/${id}.md`,
        content: encoder.encode(
          renderVendorFile(id, contract.digest, contract.body),
        ),
      });
    }
    for (const name of await listVendorEntries(root, skill.name)) {
      if (!expected.has(name))
        removals.push(`${vendorDirOf(skill.name)}/${name}`);
    }
  }
  return {
    files,
    placed: placedDests,
    lock: {
      site: LOCK_FILE,
      content: encoder.encode(
        await renderExpectedLock(
          root,
          skills,
          resolutions,
          sources,
          locations,
          declaration,
          placed.placements,
          presentRawIds(raws),
        ),
      ),
    },
    sweeps: placed.sweeps,
    removals,
    report: placed.report,
  };
}

export { closureViolations, lockViolations } from "./lock-update.ts";
