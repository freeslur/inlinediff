import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isMissingPathError } from "../errors/fs-errors.ts";
import type { FileChangeKind } from "./change-kind.ts";
import {
  listIgnoredTrackedFiles,
  listUntrackedUnignored,
  reconcileDiffIgnore,
} from "./diff-ignore.ts";
import { runProjectGit } from "./git-command.ts";
import { normalizeRelativePath, resolveSafeProjectPathOrUndefined } from "./project-path.ts";
import { isOversizedTextFile, isTrackableTextFile } from "./tracking-policy.ts";

export interface ScannedFile {
  kind: FileChangeKind;
  relativePath: string;
}

export async function scanProject(rootPath: string): Promise<ScannedFile[]> {
  const resolvedRoot = resolve(rootPath);
  await reconcileDiffIgnore(resolvedRoot);
  // The two Git queries read the same index; run them sequentially so they never race (a parallel
  // read can fail on Windows while the other refreshes the index).
  const changedTracked = await readDiffStatus(resolvedRoot);
  const addedPaths = await listUntrackedUnignored(resolvedRoot);
  // A tracked file the rules now ignore is hidden from the scan without untracking it (the index
  // is left alone; untracking happens later via untrackIgnoredFiles at startup / regenerate).
  const ignoredTracked = await listIgnoredTrackedFiles(resolvedRoot);
  const result: ScannedFile[] = [];

  for (const [relativePath, status] of changedTracked) {
    if (ignoredTracked.has(relativePath)) {
      continue;
    }
    // A path reached through a symlink is excluded: the action layer (resolveSafeProjectPath)
    // refuses to act on it, so reporting it would only show a change the user cannot accept.
    const currentPath = await resolveSafeProjectPathOrUndefined(resolvedRoot, relativePath);
    if (currentPath === undefined) {
      continue;
    }
    const kind = await classifyTrackedChange(currentPath, status);
    if (kind !== undefined) {
      result.push({ kind, relativePath });
    }
  }

  for (const relativePath of addedPaths) {
    const currentPath = await resolveSafeProjectPathOrUndefined(resolvedRoot, relativePath);
    if (currentPath !== undefined && (await isReportableTextFile(currentPath))) {
      result.push({ kind: "added", relativePath });
    }
  }

  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

// Tracked files differing from the baseline index. Untracked (added) files never appear here.
async function readDiffStatus(rootPath: string): Promise<Map<string, string>> {
  const { stdout } = await runProjectGit(rootPath, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    "--",
  ]);
  const tokens = stdout
    .toString("utf8")
    .split("\0")
    .filter((token) => token.length > 0);
  const changes = new Map<string, string>();
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const path = tokens[index + 1];
    if (path !== undefined) {
      changes.set(normalizeRelativePath(path), (tokens[index] ?? "M")[0] ?? "M");
    }
  }
  return changes;
}

async function classifyTrackedChange(
  currentPath: string,
  status: string,
): Promise<FileChangeKind | undefined> {
  if (status === "D" || !(await pathExists(currentPath))) {
    return "deleted";
  }
  if (await isOversizedIfPresent(currentPath)) {
    return undefined;
  }
  return (await isTrackableIfPresent(currentPath)) ? "modified" : "binary-modified";
}

async function isReportableTextFile(path: string): Promise<boolean> {
  if (!(await pathExists(path)) || (await isOversizedIfPresent(path))) {
    return false;
  }
  return isTrackableIfPresent(path);
}

async function isTrackableIfPresent(path: string): Promise<boolean> {
  try {
    return await isTrackableTextFile(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function isOversizedIfPresent(path: string): Promise<boolean> {
  try {
    return await isOversizedTextFile(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
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
