// records.ts — maps keyed by names the tree supplies.
//
// A name a tree supplies may be any string, and `__proto__` assigned into an
// ordinary object writes the object's prototype instead of a key — the entry
// is gone from every later reading. A lookup can go wrong the other way too:
// `constructor` names Object's own property in an ordinary object, so a map
// that answers "is this id resolved" would answer yes for a contract nobody
// recorded. Every map this tool keys by such a name is made without a
// prototype, and this file is the one place that decision lives.

/** An empty record without a prototype, for keys the tree supplies. */
export function emptyRecord<T>(): Record<string, T> {
  return Object.create(null);
}
