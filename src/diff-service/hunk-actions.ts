import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../errors/fs-errors.ts";
import { readBaselineFile } from "./baseline-store.ts";
import { CurrentFileRevisionConflictError, writeCurrentFile } from "./current-file-writer.ts";
import {
  type FileContentRevision,
  readFileContentRevision,
  revisionsEqual,
} from "./file-content-revision.ts";
import { runProjectGit, withProjectGitLock } from "./git-command.ts";
import { type DiffHunk, readFileHunks } from "./hunk-engine.ts";
import { createRejectedHunkContent } from "./hunk-reject-content.ts";
import { resolveSafeProjectPath } from "./project-path.ts";

export async function acceptHunk(
  rootPath: string,
  relativePath: string,
  hunkId: string,
  expectedCurrent?: FileContentRevision,
): Promise<void> {
  await withProjectGitLock(rootPath, async () => {
    await assertExpectedCurrent(rootPath, relativePath, expectedCurrent);
    const hunk = await findLatestFileHunk(rootPath, relativePath, hunkId);
    await assertExpectedCurrent(rootPath, relativePath, expectedCurrent);
    await applyHunk(rootPath, hunk, ["--cached"]);
  });
}

export async function rejectHunk(
  rootPath: string,
  relativePath: string,
  hunkId: string,
  expectedCurrent?: FileContentRevision,
): Promise<void> {
  await withProjectGitLock(rootPath, async () => {
    const expected = expectedCurrent ?? (await readCurrentRevision(rootPath, relativePath));
    assertRevisionMatches(
      relativePath,
      expected,
      await readCurrentRevision(rootPath, relativePath),
    );
    const hunk = await findLatestFileHunk(rootPath, relativePath, hunkId);
    const baseline = (await readBaselineFile(rootPath, relativePath)) ?? Buffer.alloc(0);
    const current = await readCurrentFile(rootPath, relativePath);
    await writeCurrentFile(
      rootPath,
      relativePath,
      createRejectedHunkContent(hunk, baseline, current),
      expected,
    );
  });
}

async function findLatestFileHunk(
  rootPath: string,
  relativePath: string,
  hunkId: string,
): Promise<DiffHunk> {
  const hunk = (await readFileHunks(rootPath, relativePath)).find(
    (candidate) => candidate.id === hunkId,
  );
  if (hunk === undefined) {
    throw new Error(`Stale diff hunk: ${hunkId}`);
  }
  return hunk;
}

async function applyHunk(
  rootPath: string,
  hunk: DiffHunk,
  modeArguments: readonly string[],
): Promise<void> {
  const arguments_ = ["apply", ...modeArguments];
  await runProjectGit(rootPath, [...arguments_, "--unidiff-zero", "--check", "-"], {
    input: hunk.patch,
  });
  await runProjectGit(rootPath, [...arguments_, "--unidiff-zero", "-"], {
    input: hunk.patch,
  });
}

async function assertExpectedCurrent(
  rootPath: string,
  relativePath: string,
  expected: FileContentRevision | undefined,
): Promise<void> {
  if (expected === undefined) {
    return;
  }
  assertRevisionMatches(relativePath, expected, await readCurrentRevision(rootPath, relativePath));
}

function assertRevisionMatches(
  relativePath: string,
  expected: FileContentRevision,
  current: FileContentRevision,
): void {
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

async function readCurrentFile(rootPath: string, relativePath: string): Promise<Buffer> {
  try {
    return await readFile(await resolveSafeProjectPath(rootPath, relativePath));
  } catch (error) {
    if (isMissingPathError(error)) {
      return Buffer.alloc(0);
    }
    throw error;
  }
}
