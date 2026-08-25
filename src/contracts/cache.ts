import { TOOL_DIR } from "./source-schema.ts";

export const CACHE_DIR = `${TOOL_DIR}/cache`;

export function cacheRevisionDirOf(source: string, revision: string): string {
  return `${CACHE_DIR}/${source}/${revision}`;
}

export function cacheSiteOf(
  source: string,
  revision: string,
  path: string,
): string {
  return `${cacheRevisionDirOf(source, revision)}/${path}`;
}
