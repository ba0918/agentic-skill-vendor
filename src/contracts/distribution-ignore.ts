import ignore from "ignore";
import { ConfigError } from "../errors.ts";

export interface DistributionIgnore {
  excludes(relative: string): boolean;
}

export function readDistributionIgnore(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${path} must be an array of text patterns, found ${JSON.stringify(value)}`,
    );
  }
  const patterns: string[] = [];
  for (const pattern of value) {
    if (typeof pattern !== "string") {
      throw new ConfigError(
        `${path} must contain only text patterns, found ${JSON.stringify(pattern)}`,
      );
    }
    assertExclusion(pattern, path);
    patterns.push(pattern);
  }
  return patterns;
}

export function createDistributionIgnore(
  shared: readonly string[],
  contract: readonly string[],
): DistributionIgnore {
  for (const pattern of shared) assertExclusion(pattern, "shared ignore");
  for (const pattern of contract) {
    assertExclusion(pattern, "contract ignore");
  }
  const matcher = ignore().add(shared).add(contract);
  return {
    excludes: (relative) => matcher.ignores(relative),
  };
}

function assertExclusion(pattern: string, path: string): void {
  if (pattern.startsWith("!")) {
    throw new ConfigError(
      `${path} cannot re-include paths with ${JSON.stringify(pattern)}; ` +
        "escape a literal leading exclamation mark as \\!",
    );
  }
}
