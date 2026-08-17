import { expect, test } from "bun:test";
import { emptyRecord } from "./records.ts";

test("a key named __proto__ is stored as an ordinary entry", () => {
  const record = emptyRecord<string>();
  // Held in a variable the way the tree supplies it — as data, not as a
  // member access the noProto lint rule rightly rejects elsewhere.
  const hostileName: string = "__proto__";
  record[hostileName] = "value";
  expect(record[hostileName]).toBe("value");
  expect(Object.keys(record)).toStrictEqual([hostileName]);
});

test("an inherited property name reads as absent until it is recorded", () => {
  const record = emptyRecord<string>();
  expect(record["constructor"]).toBeUndefined();
  expect("constructor" in record).toBe(false);
});
