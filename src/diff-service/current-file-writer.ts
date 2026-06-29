import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FileContentRevision } from "./file-content-revision.ts";
import { readFileContentRevision, revisionsEqual } from "./file-content-revision.ts";
import { resolveSafeProjectPath } from "./project-path.ts";

export class CurrentFileRevisionConflictError extends Error {
  constructor(readonly relativePath: string) {
    super(`Current file changed before Inline Diff could update it: ${relativePath}`);
  }
}

export async function writeCurrentFile(
  rootPath: string,
  relativePath: string,
  content: Buffer,
  expected: FileContentRevision,
): Promise<FileContentRevision> {
  const currentPath = await resolveSafeProjectPath(rootPath, relativePath);
  const parentPath = dirname(currentPath);
  const replacementPath = join(
    parentPath,
    `.${basename(currentPath)}.inlinediff-${randomUUID()}.tmp`,
  );
  let replaced = false;

  try {
    await mkdir(parentPath, { recursive: true });
    await writeFile(replacementPath, content, { flag: "wx" });
    assertExpectedRevision(relativePath, expected, await readFileContentRevision(currentPath));
    await rename(replacementPath, currentPath);
    replaced = true;
    return readFileContentRevision(currentPath);
  } finally {
    if (!replaced) {
      await rm(replacementPath, { force: true });
    }
  }
}

export async function deleteCurrentFile(
  rootPath: string,
  relativePath: string,
  expected: FileContentRevision,
): Promise<FileContentRevision> {
  const currentPath = await resolveSafeProjectPath(rootPath, relativePath);
  assertExpectedRevision(relativePath, expected, await readFileContentRevision(currentPath));
  await rm(currentPath, { force: true });
  return readFileContentRevision(currentPath);
}

function assertExpectedRevision(
  relativePath: string,
  expected: FileContentRevision,
  current: FileContentRevision,
): void {
  if (!revisionsEqual(expected, current)) {
    throw new CurrentFileRevisionConflictError(relativePath);
  }
}
