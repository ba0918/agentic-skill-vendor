import type { SkillDeclaration } from "./declaration.ts";
import { ConfigError } from "./errors.ts";
import type { Declaration } from "./sources.ts";

export interface FinalDestination {
  skill: string;
  contract: string;
  dest: string;
}

export function pathsOverlap(first: string, second: string): boolean {
  return (
    first === second ||
    first.startsWith(`${second}/`) ||
    second.startsWith(`${first}/`)
  );
}

export function finalRawDestinations(
  skills: SkillDeclaration[],
  declaration: Declaration,
): FinalDestination[] {
  const destinations: FinalDestination[] = [];
  for (const skill of skills) {
    for (const contract of skill.contracts) {
      for (const mapping of declaration.contracts[contract]?.files ?? []) {
        destinations.push({
          skill: skill.name,
          contract,
          dest: mapping.dest,
        });
      }
    }
  }
  return destinations;
}

export function assertFinalDestinationsDisjoint(
  destinations: FinalDestination[],
): void {
  const bySkill = new Map<string, FinalDestination[]>();
  for (const destination of destinations) {
    const placed = bySkill.get(destination.skill) ?? [];
    for (const other of placed) {
      if (!pathsOverlap(other.dest, destination.dest)) continue;
      throw new ConfigError(
        `skill ${JSON.stringify(destination.skill)} places contract ` +
          `${JSON.stringify(destination.contract)} at ` +
          `${JSON.stringify(destination.dest)}, which is the same as or ` +
          `nests with ${JSON.stringify(other.dest)} of contract ` +
          `${JSON.stringify(other.contract)}; two distributions cannot ` +
          `share a place in one skill`,
      );
    }
    placed.push(destination);
    bySkill.set(destination.skill, placed);
  }
}
