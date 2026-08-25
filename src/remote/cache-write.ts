import {
  atomicWriteDirectory,
  type PlacedFile,
} from "../filesystem/atomic-write.ts";

export interface CachedRevision {
  site: string;
  files: PlacedFile[];
}

export async function placeInCache(
  root: string,
  revisions: CachedRevision[],
): Promise<void> {
  for (const revision of revisions)
    await atomicWriteDirectory(root, revision.site, revision.files);
}
