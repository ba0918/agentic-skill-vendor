import type { SkillDeclaration } from "./declaration.ts";
import { ConfigError } from "../errors.ts";
import type { Placement } from "./lock-model.ts";
import type { Declaration } from "./sources.ts";

export interface FinalDestination {
  skill: string;
  contract: string;
  dest: string;
}

export interface RecordedDestination {
  skill: string;
  dest: string;
  placement: Placement;
}

export interface PlacementMigrationComponent {
  skill: string;
  oldDestinations: RecordedDestination[];
  finalDestinations: FinalDestination[];
  outermostDest: string;
}

interface PathNode {
  children: Map<string, PathNode>;
  old: number[];
  final: number[];
}

function pathNode(): PathNode {
  return { children: new Map(), old: [], final: [] };
}

interface FinalPathNode {
  children: Map<string, FinalPathNode>;
  terminal: FinalDestination | null;
  representative: FinalDestination | null;
}

function finalPathNode(): FinalPathNode {
  return { children: new Map(), terminal: null, representative: null };
}

function insertPath(root: PathNode, dest: string): PathNode {
  let node = root;
  for (const segment of finalDestPath(dest).split("/")) {
    let child = node.children.get(segment);
    if (child === undefined) {
      child = pathNode();
      node.children.set(segment, child);
    }
    node = child;
  }
  return node;
}

class Components {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(index: number): number {
    const parent = this.parent[index];
    if (parent === index) return index;
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }

  join(first: number, second: number): void {
    const a = this.find(first);
    const b = this.find(second);
    if (a === b) return;
    if (this.rank[a] < this.rank[b]) {
      this.parent[a] = b;
      return;
    }
    this.parent[b] = a;
    if (this.rank[a] === this.rank[b]) this.rank[a]++;
  }
}

export function finalDestPath(dest: string): string {
  return dest.endsWith("/") ? dest.slice(0, -1) : dest;
}

export function pathsOverlap(first: string, second: string): boolean {
  first = finalDestPath(first);
  second = finalDestPath(second);
  return (
    first === second ||
    first.startsWith(`${second}/`) ||
    second.startsWith(`${first}/`)
  );
}

/**
 * The same-skill old/new overlap components which can be replaced at one
 * destination already owned by either side of the transition.
 */
export function derivePlacementMigrationComponents(
  oldDestinations: RecordedDestination[],
  finalDestinations: FinalDestination[],
): PlacementMigrationComponent[] {
  const roots = new Map<string, PathNode>();
  const rootOf = (skill: string): PathNode => {
    let root = roots.get(skill);
    if (root === undefined) {
      root = pathNode();
      roots.set(skill, root);
    }
    return root;
  };
  for (let index = 0; index < oldDestinations.length; index++) {
    insertPath(
      rootOf(oldDestinations[index].skill),
      oldDestinations[index].dest,
    ).old.push(index);
  }
  for (let index = 0; index < finalDestinations.length; index++) {
    insertPath(
      rootOf(finalDestinations[index].skill),
      finalDestinations[index].dest,
    ).final.push(index);
  }

  const unions = new Components(
    oldDestinations.length + finalDestinations.length,
  );
  const overlapped = new Set<number>();
  const finalNode = (index: number): number => oldDestinations.length + index;
  const pending: {
    node: PathNode;
    oldAncestor: number | null;
    finalAncestor: number | null;
  }[] = [...roots.values()].map((node) => ({
    node,
    oldAncestor: null,
    finalAncestor: null,
  }));
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { node, oldAncestor, finalAncestor } = current;
    for (const old of node.old) {
      if (finalAncestor !== null) {
        unions.join(old, finalNode(finalAncestor));
        overlapped.add(old);
      }
      for (const final of node.final) {
        unions.join(old, finalNode(final));
        overlapped.add(old);
      }
    }
    for (const final of node.final) {
      if (oldAncestor !== null) {
        unions.join(oldAncestor, finalNode(final));
        overlapped.add(oldAncestor);
      }
    }
    const nextOld = node.old[0] ?? oldAncestor;
    const nextFinal = node.final[0] ?? finalAncestor;
    for (const child of node.children.values()) {
      pending.push({
        node: child,
        oldAncestor: nextOld,
        finalAncestor: nextFinal,
      });
    }
  }

  const grouped = new Map<number, { old: number[]; final: number[] }>();
  for (let index = 0; index < oldDestinations.length; index++) {
    if (!overlapped.has(index)) continue;
    const root = unions.find(index);
    const group = grouped.get(root) ?? { old: [], final: [] };
    group.old.push(index);
    grouped.set(root, group);
  }
  for (let index = 0; index < finalDestinations.length; index++) {
    const root = unions.find(finalNode(index));
    const group = grouped.get(root);
    if (group !== undefined) group.final.push(index);
  }

  const components: PlacementMigrationComponent[] = [];
  for (const indexes of grouped.values()) {
    const old = indexes.old.map((index) => oldDestinations[index]);
    const final = indexes.final.map((index) => finalDestinations[index]);
    const owned = [
      ...old.map((item) => item.dest),
      ...final.map((item) => item.dest),
    ];
    const outermostDest = owned.reduce((selected, candidate) =>
      finalDestPath(candidate).length < finalDestPath(selected).length
        ? candidate
        : selected,
    );
    if (
      !owned.every(
        (dest) =>
          pathsOverlap(outermostDest, dest) &&
          finalDestPath(dest).startsWith(finalDestPath(outermostDest)),
      )
    ) {
      throw new ConfigError(
        `placements in skill ${JSON.stringify(old[0].skill)} overlap but have no single owned outermost destination`,
      );
    }
    components.push({
      skill: old[0].skill,
      oldDestinations: old,
      finalDestinations: final,
      outermostDest,
    });
  }
  return components;
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
  const bySkill = new Map<string, FinalPathNode>();
  for (const destination of destinations) {
    let root = bySkill.get(destination.skill);
    if (root === undefined) {
      root = finalPathNode();
      bySkill.set(destination.skill, root);
    }
    let node = root;
    const ancestors = [root];
    let conflict: FinalDestination | null = null;
    for (const segment of finalDestPath(destination.dest).split("/")) {
      if (node.terminal !== null) {
        conflict = node.terminal;
        break;
      }
      let child = node.children.get(segment);
      if (child === undefined) {
        child = finalPathNode();
        node.children.set(segment, child);
      }
      node = child;
      ancestors.push(node);
    }
    conflict ??= node.representative;
    if (conflict !== null) {
      throw new ConfigError(
        `skill ${JSON.stringify(destination.skill)} places contract ` +
          `${JSON.stringify(destination.contract)} at ` +
          `${JSON.stringify(destination.dest)}, which is the same as or ` +
          `nests with ${JSON.stringify(conflict.dest)} of contract ` +
          `${JSON.stringify(conflict.contract)}; two distributions cannot ` +
          `share a place in one skill`,
      );
    }
    node.terminal = destination;
    for (const ancestor of ancestors) {
      ancestor.representative ??= destination;
    }
  }
}
