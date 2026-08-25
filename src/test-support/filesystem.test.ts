import { expect, test } from "bun:test";
import { processUidOf } from "./filesystem.ts";

test("a runtime with no process global contributes no uid", () => {
  // The permission gating is computed at module load. On a runtime without a
  // `process` global — Deno, which this package claims to support — reading the
  // global directly throws a ReferenceError; the helper answers the same way a
  // runtime with no getuid method does instead of reaching for it.
  expect(processUidOf({})).toBeUndefined();
});

test("a getuid method contributes the uid it returns", () => {
  expect(processUidOf({ getuid: () => 0 })).toStrictEqual(0);
  expect(processUidOf({ getuid: () => 1000 })).toStrictEqual(1000);
});
