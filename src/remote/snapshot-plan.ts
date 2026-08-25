import { ConfigError } from "../errors.ts";
import { compareStrings } from "../ordering.ts";
import type { Declaration } from "../contracts/sources.ts";
import { DECLARATION_FILE } from "../contracts/sources.ts";
import type { LockSources } from "../contracts/lock-model.ts";
import type { SnapshotTarget } from "./remote.ts";

export interface SnapshotRequest {
  name: string;
  repository: string;
  target: SnapshotTarget;
}

export function contractsOf(
  declaration: Declaration,
  source: string,
): string[] {
  return Object.keys(declaration.contracts)
    .filter((id) => declaration.contracts[id].source === source)
    .sort(compareStrings);
}

export function updateRequests(declaration: Declaration): SnapshotRequest[] {
  return Object.keys(declaration.sources)
    .sort(compareStrings)
    .map((name) => {
      const source = declaration.sources[name];
      return {
        name,
        repository: source.repository,
        target: { kind: "ref" as const, ref: source.ref },
      };
    });
}

export function fetchRequests(
  declaration: Declaration,
  sources: LockSources,
): SnapshotRequest[] {
  const requests: SnapshotRequest[] = [];
  for (const name of Object.keys(declaration.sources).sort(compareStrings)) {
    if (contractsOf(declaration, name).length === 0) continue;
    const pinned = sources[name];
    if (pinned === undefined) {
      throw new ConfigError(
        `${DECLARATION_FILE} registers the source ${name} but the lock records no commit for it; run update to resolve one`,
      );
    }
    requests.push({
      name,
      repository: pinned.repository,
      target: {
        kind: "pin",
        revision: pinned.revision,
        objectFormat: pinned.objectFormat ?? "sha1",
        ref: declaration.sources[name].ref,
      },
    });
  }
  return requests;
}
