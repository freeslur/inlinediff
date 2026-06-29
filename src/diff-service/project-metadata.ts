import { readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { isMissingOrInaccessiblePathError } from "../errors/fs-errors.ts";

const metadataFileName = "project.json";
const metadataCreatedBy = "inlinediff";
const metadataSchemaVersion = 1;

export interface ProjectMetadata {
  readonly createdBy: typeof metadataCreatedBy;
  readonly rootPath: string;
  readonly schemaVersion: typeof metadataSchemaVersion;
  readonly storeId: string;
}

export function projectMetadataPath(rootPath: string): string {
  return join(resolve(rootPath), ".inlinediff", metadataFileName);
}

export async function writeProjectMetadata(rootPath: string, storeId: string): Promise<void> {
  const trustedMetadata: ProjectMetadata = {
    createdBy: metadataCreatedBy,
    rootPath: resolve(rootPath),
    schemaVersion: metadataSchemaVersion,
    storeId,
  };
  await writeFile(projectMetadataPath(rootPath), `${JSON.stringify(trustedMetadata, null, 2)}\n`);
}

export async function readProjectMetadata(rootPath: string): Promise<ProjectMetadata | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(projectMetadataPath(rootPath), "utf8"));
  } catch (error) {
    if (isBenignMetadataReadError(error)) {
      return undefined;
    }
    throw error;
  }

  if (!isProjectMetadata(value, rootPath)) {
    return undefined;
  }
  return value;
}

export async function hasTrustedProjectMetadata(rootPath: string): Promise<boolean> {
  return (await readProjectMetadata(rootPath)) !== undefined;
}

function isProjectMetadata(value: unknown, rootPath: string): value is ProjectMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "createdBy" in value &&
    "rootPath" in value &&
    "schemaVersion" in value &&
    "storeId" in value &&
    value.createdBy === metadataCreatedBy &&
    typeof value.rootPath === "string" &&
    pathsEqual(value.rootPath, resolve(rootPath)) &&
    value.schemaVersion === metadataSchemaVersion &&
    typeof value.storeId === "string" &&
    value.storeId.length > 0
  );
}

function pathsEqual(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (platform() === "win32") {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }
  return resolvedLeft === resolvedRight;
}

function isBenignMetadataReadError(error: unknown): boolean {
  return error instanceof SyntaxError || isMissingOrInaccessiblePathError(error);
}
