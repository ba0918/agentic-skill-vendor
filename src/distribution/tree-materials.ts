import { compareStrings } from "../ordering.ts";
import { assertTreeRoot } from "../filesystem/walk.ts";
import {
  declaredIds,
  readSkills,
  type SkillDeclaration,
} from "../contracts/declaration.ts";
import {
  type LockSources,
  type Placements,
  readLock,
  type Resolutions,
} from "../contracts/manifest.ts";
import {
  type ContractLocation,
  type Declaration,
  readDeclaration,
} from "../contracts/source-schema.ts";
import {
  assertFinalDestinationsDisjoint,
  finalRawDestinations,
} from "../contracts/placement-ownership.ts";
import {
  type CanonicalContract,
  conformanceDirectoriesOf,
  locateContracts,
  readContracts,
} from "./contract-discovery.ts";
import {
  assertKindsAgree,
  assertSrcsClearOfConformance,
  type RawContracts,
  readRawContracts,
} from "./placements.ts";

export interface TreeState {
  resolutions: Resolutions;
  placements: Placements;
  skills: SkillDeclaration[];
  sources: LockSources;
  declaration: Declaration;
}

export interface TreeMaterials {
  state: TreeState;
  locations: Map<string, ContractLocation>;
  contracts: Map<string, CanonicalContract | null>;
  raws: RawContracts;
}

export async function readTreeState(root: string): Promise<TreeState> {
  await assertTreeRoot(root);
  const { recordedSkills, resolutions, placements, sources } =
    await readLock(root);
  const skills = await readSkills(root, recordedSkills);
  return {
    resolutions,
    placements,
    skills,
    sources,
    declaration: await readDeclaration(root),
  };
}

export function lockedOrDeclared(
  skills: SkillDeclaration[],
  resolutions: Resolutions,
): string[] {
  return [
    ...new Set([...declaredIds(skills), ...Object.keys(resolutions)]),
  ].sort(compareStrings);
}

export async function locateTreeContracts(
  root: string,
  state: TreeState,
): Promise<Map<string, ContractLocation>> {
  return await locateContracts(
    root,
    state.declaration,
    state.sources,
    lockedOrDeclared(state.skills, state.resolutions),
  );
}

export async function prepareTreeMaterials(
  root: string,
  state: TreeState,
): Promise<TreeMaterials> {
  const { skills, resolutions, sources, declaration } = state;
  assertFinalDestinationsDisjoint(finalRawDestinations(skills, declaration));
  assertKindsAgree(declaration, resolutions);
  const locations = await locateTreeContracts(root, state);
  assertSrcsClearOfConformance(
    declaration,
    conformanceDirectoriesOf(locations, declaration),
  );
  const contracts = await readContracts(root, locations);
  const raws = await readRawContracts(
    root,
    declaration,
    sources,
    lockedOrDeclared(skills, resolutions),
  );
  return { state, locations, contracts, raws };
}
