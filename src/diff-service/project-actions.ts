import { toErrorMessage } from "../errors/error-message.ts";
import { readBaselineFile, writeBaselineFile } from "./baseline-store.ts";
import { CurrentFileRevisionConflictError } from "./current-file-writer.ts";
import { rejectFile } from "./file-actions.ts";
import {
  type FileContentRevision,
  readFileContentSnapshot,
  revisionsEqual,
} from "./file-content-revision.ts";
import { runProjectGit, withProjectGitLock } from "./git-command.ts";
import { resolveSafeProjectPath } from "./project-path.ts";
import { type ScannedFile, scanProject } from "./project-scanner.ts";
import { isTrackableTextContent } from "./tracking-policy.ts";

export interface ProjectActionFailure {
  readonly error: string;
  readonly relativePath: string;
}

export interface ProjectActionSummary {
  readonly attempted: number;
  readonly failed: readonly ProjectActionFailure[];
  readonly succeeded: readonly string[];
  readonly total: number;
}

interface ProjectActionDependencies {
  readonly runProjectGit: typeof runProjectGit;
  readonly scanProject: typeof scanProject;
  readonly withProjectGitLock: typeof withProjectGitLock;
  readonly writeBaselineFile: typeof writeBaselineFile;
}

const defaultDependencies: ProjectActionDependencies = {
  runProjectGit,
  scanProject,
  withProjectGitLock,
  writeBaselineFile,
};

type ProjectFilePreflight = (
  file: ScannedFile,
) => FileContentRevision | Promise<FileContentRevision | undefined> | undefined;

export async function acceptAllFiles(
  rootPath: string,
  beforeAction?: ProjectFilePreflight,
  dependencies: ProjectActionDependencies = defaultDependencies,
): Promise<ProjectActionSummary> {
  return acceptChangedFiles(rootPath, beforeAction, dependencies);
}

export async function rejectAllFiles(
  rootPath: string,
  beforeAction?: ProjectFilePreflight,
): Promise<ProjectActionSummary> {
  return applyToChangedFiles(rootPath, rejectFile, beforeAction);
}

type AcceptedFileMode = "write" | "remove";

interface PlannedAcceptedFile {
  readonly content?: Buffer | undefined;
  readonly mode: AcceptedFileMode;
  readonly relativePath: string;
}

interface PlannedProjectFile {
  readonly expectedCurrent?: FileContentRevision | undefined;
  readonly relativePath: string;
}

async function acceptChangedFiles(
  rootPath: string,
  beforeAction: ProjectFilePreflight | undefined,
  dependencies: ProjectActionDependencies,
): Promise<ProjectActionSummary> {
  const changedFiles = (await dependencies.scanProject(rootPath)).filter(
    (file) => file.kind !== "clean",
  );
  const failed: ProjectActionFailure[] = [];
  const plannedPaths: PlannedProjectFile[] = [];

  for (const file of changedFiles) {
    try {
      plannedPaths.push({
        expectedCurrent: (await beforeAction?.(file)) ?? undefined,
        relativePath: file.relativePath,
      });
    } catch (error) {
      failed.push({ error: toErrorMessage(error), relativePath: file.relativePath });
    }
  }

  const planned: PlannedAcceptedFile[] = [];
  const failedPlannedPaths = new Set<string>();
  let removeError: unknown;

  await dependencies.withProjectGitLock(rootPath, async () => {
    for (const file of plannedPaths) {
      try {
        planned.push(await planAcceptedFile(rootPath, file));
      } catch (error) {
        failed.push({ error: toErrorMessage(error), relativePath: file.relativePath });
      }
    }

    const removePaths = planned
      .filter((file) => file.mode === "remove")
      .map((file) => file.relativePath);

    for (const file of planned) {
      if (file.mode !== "write") {
        continue;
      }
      try {
        await dependencies.writeBaselineFile(
          rootPath,
          file.relativePath,
          file.content ?? Buffer.alloc(0),
        );
      } catch (error) {
        failedPlannedPaths.add(file.relativePath);
        failed.push({ error: toErrorMessage(error), relativePath: file.relativePath });
      }
    }
    // Writes are isolated per file because each stages its own blob and can fail independently.
    // Removes are intentionally one atomic `git rm --cached --ignore-unmatch` (tolerant of missing
    // paths), so they share a single outcome by design rather than being split into N git calls.
    if (removePaths.length > 0) {
      try {
        await dependencies.runProjectGit(rootPath, [
          "--literal-pathspecs",
          "rm",
          "--cached",
          "--force",
          "--ignore-unmatch",
          "--",
          ...removePaths,
        ]);
      } catch (error) {
        removeError = error;
      }
    }
  });

  const succeeded: string[] = [];
  for (const file of planned) {
    if (failedPlannedPaths.has(file.relativePath)) {
      continue;
    }
    const error = file.mode === "write" ? undefined : removeError;
    if (error === undefined) {
      succeeded.push(file.relativePath);
      continue;
    }
    failed.push({ error: toErrorMessage(error), relativePath: file.relativePath });
  }

  return {
    attempted: succeeded.length + failed.length,
    failed,
    succeeded,
    total: changedFiles.length,
  };
}

async function planAcceptedFile(
  rootPath: string,
  file: PlannedProjectFile,
): Promise<PlannedAcceptedFile> {
  const { expectedCurrent, relativePath } = file;
  const currentPath = await resolveSafeProjectPath(rootPath, relativePath);
  const snapshot = await readFileContentSnapshot(currentPath);
  assertExpectedRevision(relativePath, expectedCurrent, snapshot.revision);
  if (snapshot.content === undefined) {
    return { mode: "remove", relativePath };
  }
  if (!isTrackableTextContent(snapshot.content)) {
    if ((await readBaselineFile(rootPath, relativePath)) === undefined) {
      throw new Error(`Binary file is outside Inline Diff scope: ${relativePath}`);
    }
    return { mode: "remove", relativePath };
  }
  return { content: snapshot.content, mode: "write", relativePath };
}

async function applyToChangedFiles(
  rootPath: string,
  action: (
    rootPath: string,
    relativePath: string,
    expectedCurrent?: FileContentRevision,
  ) => Promise<void>,
  beforeAction?: ProjectFilePreflight,
): Promise<ProjectActionSummary> {
  const changedFiles = (await scanProject(rootPath)).filter((file) => file.kind !== "clean");
  const failed: ProjectActionFailure[] = [];
  const succeeded: string[] = [];

  for (const file of changedFiles) {
    try {
      const expectedCurrent = (await beforeAction?.(file)) ?? undefined;
      await action(rootPath, file.relativePath, expectedCurrent);
      succeeded.push(file.relativePath);
    } catch (error) {
      failed.push({ error: toErrorMessage(error), relativePath: file.relativePath });
    }
  }

  return {
    attempted: succeeded.length + failed.length,
    failed,
    succeeded,
    total: changedFiles.length,
  };
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
