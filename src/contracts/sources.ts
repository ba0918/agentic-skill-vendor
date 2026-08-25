import { contractPath } from "./digest.ts";
import {
  assertPlainChain,
  isRegularFileOrAbsent,
  readTextFile,
} from "../filesystem/walk.ts";
import { emptyDeclaration, parseDeclaration } from "./source-schema.ts";

export const DECLARATION_FILE = "vendor-manifest.yaml";
export const LOCAL_SOURCE = "local";
export const TOOL_DIR = ".agentic-skill-vendor";
export const VENDOR_SUBPATH = "references/vendor";

export interface SourceRecord {
  repository: string;
  ref: string;
}

export interface ContractOrigin {
  source: string;
  ignore: string[];
  path?: string;
  files?: RawMapping[];
}

export type RawKind = "file" | "directory";

export interface RawMapping {
  src: string;
  dest: string;
  kind: RawKind;
}

export interface Declaration {
  sources: Record<string, SourceRecord>;
  contracts: Record<string, ContractOrigin>;
  ignore: string[];
}

export type ContractLocation =
  | { local: true; site: string }
  | { local: false; site: string | null };

export function originPathOf(
  id: string,
  origin: ContractOrigin | undefined,
): string {
  return origin?.path ?? contractPath(id);
}

export async function readDeclaration(root: string): Promise<Declaration> {
  await assertPlainChain(root, DECLARATION_FILE);
  if (!(await isRegularFileOrAbsent(root, DECLARATION_FILE))) {
    return emptyDeclaration();
  }
  return parseDeclaration(
    await readTextFile(`${root}/${DECLARATION_FILE}`, DECLARATION_FILE),
  );
}
