import { readFile, stat } from "node:fs/promises";
import { readBaselineFile } from "../diff-service/baseline-store.ts";
import { listUntrackedUnignored, syncDiffIgnore } from "../diff-service/diff-ignore.ts";
import { resolveSafeProjectPathOrUndefined } from "../diff-service/project-path.ts";
import { isOversizedTextFile, isTrackableTextFile } from "../diff-service/tracking-policy.ts";
import { isMissingPathError } from "../errors/fs-errors.ts";
import type { ScannedFileLike } from "./changed-files-store.ts";

export async function classifyChangedFile(
  rootPath: string,
  relativePath: string,
): Promise<ScannedFileLike> {
  const baseline = await readBaselineFile(rootPath, relativePath);
  const currentPath = await resolveSafeProjectPathOrUndefined(rootPath, relativePath);
  if (currentPath === undefined) {
    // A symlinked path is ignored like a binary/oversized file: not shown, never followed.
    return { kind: "clean", relativePath };
  }
  const currentExists = await pathExists(currentPath);

  if (!currentExists) {
    return {
      kind: baseline === undefined ? "clean" : "deleted",
      relativePath,
    };
  }

  if (baseline === undefined && !(await isVisibleAddedPath(rootPath, relativePath))) {
    return { kind: "clean", relativePath };
  }

  if (await isOversizedTextFile(currentPath)) {
    return { kind: "clean", relativePath };
  }

  if (!(await isTrackableTextFile(currentPath))) {
    return {
      kind: baseline === undefined ? "clean" : "binary-modified",
      relativePath,
    };
  }

  if (baseline === undefined) {
    return { kind: "added", relativePath };
  }

  const current = await readFile(currentPath);
  return {
    kind: Buffer.compare(baseline, current) === 0 ? "clean" : "modified",
    relativePath,
  };
}

async function isVisibleAddedPath(rootPath: string, relativePath: string): Promise<boolean> {
  await syncDiffIgnore(rootPath);
  return (await listUntrackedUnignored(rootPath, [relativePath])).has(relativePath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}
