import { ancestorDirectories, readIgnoreRules } from "./ignore.ts";

export async function workDirectoryIsIgnored(
  root: string,
  relative: string,
): Promise<boolean> {
  const rules = await readIgnoreRules(root, ancestorDirectories(relative));
  return rules.excludes(relative, true);
}

export function unignoredWorkDirectoryWarning(relative: string): string {
  return (
    `warning: ${relative} is not ignored by this repository; add ` +
    `/${relative.split("/")[0]}/ to .gitignore so the tool's working ` +
    `files are never committed`
  );
}
