import { toErrorMessage } from "../errors/error-message.ts";
import { CurrentFileRevisionConflictError } from "./current-file-writer.ts";
import type { FileContentRevision } from "./file-content-revision.ts";
import { readFileContentRevision, revisionsEqual } from "./file-content-revision.ts";
import { runProjectGit, withProjectGitLock } from "./git-command.ts";
import { type DiffHunk, readFileHunks } from "./hunk-engine.ts";
import { resolveSafeProjectPath } from "./project-path.ts";

export interface HunkActionFailure {
  readonly error: string;
  readonly hunkId: string;
}

export interface HunkActionSummary {
  readonly attempted: number;
  readonly failed: readonly HunkActionFailure[];
  readonly kept: readonly string[];
  readonly succeeded: readonly string[];
  readonly total: number;
}

type HunkPreflight = (
  hunk: DiffHunk,
) => FileContentRevision | Promise<FileContentRevision | undefined> | undefined;

interface HunkBulkDependencies {
  readonly readFileHunks: typeof readFileHunks;
  readonly runProjectGit: typeof runProjectGit;
  readonly withProjectGitLock: typeof withProjectGitLock;
}

const defaultDependencies: HunkBulkDependencies = {
  readFileHunks,
  runProjectGit,
  withProjectGitLock,
};

interface PlannedHunk {
  readonly expectedCurrent?: FileContentRevision | undefined;
  readonly hunkId: string;
}

export async function acceptUnkeptHunks(
  rootPath: string,
  relativePath: string,
  keptHunkIds: ReadonlySet<string>,
  beforeAction?: HunkPreflight,
  dependencies: HunkBulkDependencies = defaultDependencies,
): Promise<HunkActionSummary> {
  const hunks = await dependencies.readFileHunks(rootPath, relativePath);
  const failed: HunkActionFailure[] = [];
  const kept: string[] = [];
  const planned: PlannedHunk[] = [];

  for (const hunk of hunks) {
    if (keptHunkIds.has(hunk.id)) {
      kept.push(hunk.id);
      continue;
    }
    try {
      planned.push({
        expectedCurrent: (await beforeAction?.(hunk)) ?? undefined,
        hunkId: hunk.id,
      });
    } catch (error) {
      failed.push({ error: toErrorMessage(error), hunkId: hunk.id });
    }
  }

  const succeeded: string[] = [];
  await dependencies.withProjectGitLock(rootPath, async () => {
    const applicable = await findApplicableLatestHunks(
      rootPath,
      relativePath,
      planned,
      failed,
      dependencies,
    );
    if (applicable.length === 0) {
      return;
    }

    try {
      const patch = combineHunkPatches(applicable.map((hunk) => hunk.hunk));
      await applyCombinedHunkPatch(rootPath, patch, dependencies);
      succeeded.push(...applicable.map((hunk) => hunk.hunkId));
    } catch (error) {
      // The patch is always for a single file, so `git apply --cached` stages it atomically: after
      // the --check passes, the apply either updates the whole index entry or leaves it untouched.
      // There is no partial-apply state, so reporting every applicable hunk as failed is accurate.
      for (const hunk of applicable) {
        failed.push({ error: toErrorMessage(error), hunkId: hunk.hunkId });
      }
    }
  });

  return {
    attempted: succeeded.length + failed.length,
    failed,
    kept,
    succeeded,
    total: hunks.length,
  };
}

async function findApplicableLatestHunks(
  rootPath: string,
  relativePath: string,
  planned: readonly PlannedHunk[],
  failed: HunkActionFailure[],
  dependencies: HunkBulkDependencies,
): Promise<Array<{ hunk: DiffHunk; hunkId: string }>> {
  // The two assert passes below bracket the latest-hunks read. The second pass is the load-bearing
  // one: it confirms the file is still at the preflight revision *after* the read, so the hunks we
  // apply were computed from the expected state — dropping it reopens a window where a change during
  // the read is silently accepted (a regression test pins exactly this). The first pass is a
  // fail-fast that skips the read when a hunk is already stale.
  const failedHunkIds = new Set<string>();
  for (const hunk of planned) {
    try {
      await assertExpectedCurrent(rootPath, relativePath, hunk.expectedCurrent);
    } catch (error) {
      failedHunkIds.add(hunk.hunkId);
      failed.push({ error: toErrorMessage(error), hunkId: hunk.hunkId });
    }
  }
  const currentPlanned = planned.filter((hunk) => !failedHunkIds.has(hunk.hunkId));
  if (currentPlanned.length === 0) {
    return [];
  }
  const latestHunks = new Map(
    (await dependencies.readFileHunks(rootPath, relativePath)).map((hunk) => [hunk.id, hunk]),
  );
  for (const hunk of currentPlanned) {
    try {
      await assertExpectedCurrent(rootPath, relativePath, hunk.expectedCurrent);
    } catch (error) {
      failedHunkIds.add(hunk.hunkId);
      failed.push({ error: toErrorMessage(error), hunkId: hunk.hunkId });
    }
  }

  const applicable: Array<{ hunk: DiffHunk; hunkId: string }> = [];
  for (const hunk of currentPlanned) {
    if (failedHunkIds.has(hunk.hunkId)) {
      continue;
    }
    const latest = latestHunks.get(hunk.hunkId);
    if (latest === undefined) {
      failed.push({ error: `Stale diff hunk: ${hunk.hunkId}`, hunkId: hunk.hunkId });
      continue;
    }
    applicable.push({ hunk: latest, hunkId: hunk.hunkId });
  }
  return applicable;
}

async function applyCombinedHunkPatch(
  rootPath: string,
  patch: Buffer,
  dependencies: HunkBulkDependencies,
): Promise<void> {
  const arguments_ = ["apply", "--cached", "--unidiff-zero"];
  await dependencies.runProjectGit(rootPath, [...arguments_, "--check", "-"], { input: patch });
  await dependencies.runProjectGit(rootPath, [...arguments_, "-"], { input: patch });
}

function combineHunkPatches(hunks: readonly DiffHunk[]): Buffer {
  // Every hunk here belongs to the same file, so the bytes before the first hunk's "@@ " are the
  // shared file header (diff --git / --- / +++). We keep that header once and append each hunk body.
  const firstHunk = hunks[0];
  if (firstHunk === undefined) {
    return Buffer.alloc(0);
  }

  const headerEnd = firstHunk.patch.indexOf("@@ ");
  if (headerEnd < 0) {
    throw new Error("Invalid Git hunk patch.");
  }
  return Buffer.concat([
    firstHunk.patch.subarray(0, headerEnd),
    ...hunks.map((hunk) => {
      const hunkStart = hunk.patch.indexOf("@@ ");
      if (hunkStart < 0) {
        throw new Error("Invalid Git hunk patch.");
      }
      return hunk.patch.subarray(hunkStart);
    }),
  ]);
}

async function assertExpectedCurrent(
  rootPath: string,
  relativePath: string,
  expected: FileContentRevision | undefined,
): Promise<void> {
  if (expected === undefined) {
    return;
  }
  const current = await readFileContentRevision(
    await resolveSafeProjectPath(rootPath, relativePath),
  );
  if (!revisionsEqual(expected, current)) {
    throw new CurrentFileRevisionConflictError(relativePath);
  }
}
