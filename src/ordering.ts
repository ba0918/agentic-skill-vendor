/** Locale-independent deterministic ordering by UTF-16 code unit. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
