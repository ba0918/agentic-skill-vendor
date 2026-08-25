import { expect, test } from "bun:test";
import { compareStrings } from "./ordering.ts";

test("orders text by locale-independent UTF-16 code units", () => {
  expect(["a10", "a2", "Z", "ä"].sort(compareStrings)).toStrictEqual([
    "Z",
    "a10",
    "a2",
    "ä",
  ]);
});
