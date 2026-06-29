import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMissingOrInaccessiblePathError } from "../errors/fs-errors.ts";
import { hasTrustedProjectMetadata } from "./project-metadata.ts";

// A project is a workspace folder that has a .inlinediff store at its root — nothing else. We never
// descend into the tree: a .inlinediff nested deeper is just ignored data, not its own project. It
// becomes a project only when that folder is itself opened as a workspace root.
export async function discoverInlineDiffStoreRoots(
  workspaceRoots: readonly string[],
): Promise<string[]> {
  const storeRoots = new Set<string>();
  for (const rootPath of workspaceRoots) {
    const resolvedRoot = resolve(rootPath);
    if (await directoryExists(join(resolvedRoot, ".inlinediff"))) {
      storeRoots.add(resolvedRoot);
    }
  }
  return [...storeRoots].sort((left, right) => left.localeCompare(right));
}

export interface WorkspaceStores {
  readonly projectRoots: string[];
  readonly storeRoots: string[];
}

// storeRoots = workspace folders that hold a .inlinediff store; projectRoots = those with valid
// metadata. Trusted roots and untrusted stores are derived from this without re-walking.
export async function discoverWorkspaceStores(
  workspaceRoots: readonly string[],
): Promise<WorkspaceStores> {
  const storeRoots = await discoverInlineDiffStoreRoots(workspaceRoots);
  const projectRoots: string[] = [];
  for (const rootPath of storeRoots) {
    if (await hasTrustedProjectMetadata(rootPath)) {
      projectRoots.push(rootPath);
    }
  }
  return { projectRoots, storeRoots };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingOrInaccessiblePathError(error)) {
      return false;
    }
    throw error;
  }
}
