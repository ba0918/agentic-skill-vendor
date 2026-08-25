export { runCli } from "./cli.ts";
export type { CliResult } from "./cli.ts";
export { withEmptyDir, withGoodTree, withRemoteFixture } from "./fixtures.ts";
export {
  append,
  escapeThrough,
  PERMISSIONS_APPLY,
  processUidOf,
  replaceWithSymlink,
  snapshotTree,
  withUnreadable,
  writeFile,
} from "./filesystem.ts";
export { importClosureOf } from "./imports.ts";
export {
  kindsOf,
  readLockFile,
  rejectedBy,
  thrownBy,
  writeLockFile,
} from "./assertions.ts";
export type { Json } from "./assertions.ts";
export { fakeGitHub, REMOTE, remoteSource, withFetchedTree } from "./remote.ts";
export type { FakeGitHub, FakeRepository } from "./remote.ts";
