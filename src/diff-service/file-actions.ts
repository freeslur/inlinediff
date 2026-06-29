import { readBaselineFile, writeBaselineFile } from "./baseline-store.ts";
import {
  CurrentFileRevisionConflictError,
  deleteCurrentFile,
  writeCurrentFile,
} from "./current-file-writer.ts";
import {
  type FileContentRevision,
  readFileContentRevision,
  readFileContentSnapshot,
  revisionsEqual,
} from "./file-content-revision.ts";
import { runProjectGit, withProjectGitLock } from "./git-command.ts";
import { resolveSafeProjectPath } from "./project-path.ts";
import { isTrackableTextContent } from "./tracking-policy.ts";

export async function acceptFile(
  rootPath: string,
  relativePath: string,
  expectedCurrent?: FileContentRevision,
): Promise<void> {
  await withProjectGitLock(rootPath, () =>
    acceptFileUnlocked(rootPath, relativePath, expectedCurrent),
  );
}

async function acceptFileUnlocked(
  rootPath: string,
  relativePath: string,
  expectedCurrent: FileContentRevision | undefined,
): Promise<void> {
  const currentPath = await resolveSafeProjectPath(rootPath, relativePath);
  const snapshot = await readFileContentSnapshot(currentPath);
  assertExpectedRevision(relativePath, expectedCurrent, snapshot.revision);
  if (snapshot.content === undefined) {
    await removeBaselineFile(rootPath, relativePath);
    return;
  }

  if (!isTrackableTextContent(snapshot.content)) {
    if ((await readBaselineFile(rootPath, relativePath)) === undefined) {
      throw new Error(`Binary file is outside Inline Diff scope: ${relativePath}`);
    }
    await removeBaselineFile(rootPath, relativePath);
    return;
  }

  await writeBaselineFile(rootPath, relativePath, snapshot.content);
}

export async function rejectFile(
  rootPath: string,
  relativePath: string,
  expectedCurrent?: FileContentRevision,
): Promise<void> {
  await withProjectGitLock(rootPath, () =>
    rejectFileUnlocked(rootPath, relativePath, expectedCurrent),
  );
}

async function rejectFileUnlocked(
  rootPath: string,
  relativePath: string,
  expectedCurrent: FileContentRevision | undefined,
): Promise<void> {
  await resolveSafeProjectPath(rootPath, relativePath);
  const expected = expectedCurrent ?? (await readCurrentRevision(rootPath, relativePath));
  const baseline = await readBaselineFile(rootPath, relativePath);
  if (baseline !== undefined) {
    await writeCurrentFile(rootPath, relativePath, baseline, expected);
    return;
  }

  await deleteCurrentFile(rootPath, relativePath, expected);
}

function assertExpectedRevision(
  relativePath: string,
  expected: FileContentRevision | undefined,
  current: FileContentRevision,
): void {
  if (expected === undefined) {
    return;
  }
  if (!revisionsEqual(expected, current)) {
    throw new CurrentFileRevisionConflictError(relativePath);
  }
}

async function readCurrentRevision(
  rootPath: string,
  relativePath: string,
): Promise<FileContentRevision> {
  return readFileContentRevision(await resolveSafeProjectPath(rootPath, relativePath));
}

async function removeBaselineFile(rootPath: string, relativePath: string): Promise<void> {
  await runProjectGit(rootPath, [
    "--literal-pathspecs",
    "rm",
    "--cached",
    "--force",
    "--ignore-unmatch",
    "--",
    relativePath,
  ]);
}
