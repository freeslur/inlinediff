import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMissingPathError } from "../errors/fs-errors.ts";
import { isProtectedPathName } from "./structural-policy.ts";

export class InvalidProjectPathError extends Error {
  constructor(relativePath: string) {
    super(`Invalid project path: ${relativePath}`);
    this.name = "InvalidProjectPathError";
  }
}

export function resolveProjectPath(rootPath: string, relativePath: string): string {
  const resolvedRoot = resolve(rootPath);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const pathFromRoot = relative(resolvedRoot, resolvedPath);
  const segments = pathFromRoot.split(sep);

  if (
    pathFromRoot.length === 0 ||
    pathFromRoot.startsWith(`..${sep}`) ||
    pathFromRoot === ".." ||
    isAbsolute(pathFromRoot) ||
    segments.some(isProtectedPathName)
  ) {
    throw new InvalidProjectPathError(relativePath);
  }

  return resolvedPath;
}

export async function resolveSafeProjectPath(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const resolvedRoot = resolve(rootPath);
  const resolvedPath = resolveProjectPath(resolvedRoot, relativePath);
  let currentPath = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedPath).split(sep)) {
    currentPath = join(currentPath, segment);
    try {
      if ((await lstat(currentPath)).isSymbolicLink()) {
        throw new InvalidProjectPathError(relativePath);
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        break;
      }
      throw error;
    }
  }
  return resolvedPath;
}

// Like resolveSafeProjectPath, but returns undefined instead of throwing when the path is rejected
// as unsafe (e.g. reached through a symlink). For callers that treat such paths as "ignored".
export async function resolveSafeProjectPathOrUndefined(
  rootPath: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    return await resolveSafeProjectPath(rootPath, relativePath);
  } catch (error) {
    if (error instanceof InvalidProjectPathError) {
      return undefined;
    }
    throw error;
  }
}

export function normalizeRelativePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
