import type { LockSources } from "../contracts/lock-model.ts";

export interface MissingRemoteContracts {
  missing: string[];
  unpinned: string[];
}

/** Classifies absent remote material without deciding caller-specific wording. */
export function classifyMissingRemoteContracts(
  ids: string[],
  isMissing: (id: string) => boolean,
  sourceOf: (id: string) => string,
  sources: LockSources,
): MissingRemoteContracts {
  const missing = ids.filter(isMissing);
  return {
    missing,
    unpinned: missing.filter((id) => sources[sourceOf(id)] === undefined),
  };
}
