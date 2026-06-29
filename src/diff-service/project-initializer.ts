import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMissingPathError } from "../errors/fs-errors.ts";
import { ensureDiffIgnore, listUntrackedUnignored, syncDiffIgnore } from "./diff-ignore.ts";
import {
  assertGitAvailable,
  runGitExecutable,
  runGitRepository,
  runProjectGit,
  withProjectGitLock,
} from "./git-command.ts";
import { tryClaimInitializationStore } from "./initialization-store.ts";
import { writeProjectMetadata } from "./project-metadata.ts";
import { resolveSafeProjectPathOrUndefined } from "./project-path.ts";
import { isTrackableTextFile } from "./tracking-policy.ts";

export async function initializeProject(rootPath: string): Promise<string> {
  return withProjectGitLock(rootPath, () => initializeProjectUnlocked(rootPath));
}

export async function reinitializeProject(rootPath: string): Promise<string> {
  // This destroys and recreates the store without taking the operation lock, and that is safe:
  // within a process, reinit and every index-writing operation share withProjectGitLock and cannot
  // interleave; across windows, reinit runs only on an untrusted store while operations run only on
  // a trusted one, and trust is machine-global, so they cannot target the same store at once. Two
  // windows that both see the store as untrusted could reinit concurrently, but each only wholesale-
  // replaces .inlinediff (never the user's files), so the worst case is "last writer wins", not
  // partial corruption. Taking the operation lock here would instead let a stale lock block recovery.
  return withProjectGitLock(rootPath, async () => {
    const resolvedRoot = resolve(rootPath);
    await assertGitAvailable();
    await rm(join(resolvedRoot, ".inlinediff"), { force: true, recursive: true });
    return initializeProjectUnlocked(resolvedRoot);
  });
}

export async function findInitializableProjectRoots(
  rootPaths: readonly string[],
): Promise<string[]> {
  const candidates = await Promise.all(
    rootPaths.map(async (rootPath) => ({
      initializable: !(await pathExists(join(resolve(rootPath), ".inlinediff"))),
      rootPath,
    })),
  );
  return candidates
    .filter((candidate) => candidate.initializable)
    .map((candidate) => candidate.rootPath);
}

async function initializeProjectUnlocked(rootPath: string): Promise<string> {
  const resolvedRoot = resolve(rootPath);
  const storeId = randomUUID();
  const storePath = join(resolvedRoot, ".inlinediff");
  if (await pathExists(storePath)) {
    throw new Error(".inlinediff already exists");
  }

  await assertGitAvailable();
  const repositoryPath = join(storePath, "repository");
  const storeClaim = await tryClaimInitializationStore(storePath);
  if (storeClaim === undefined) {
    throw new Error(".inlinediff already exists");
  }
  let initialized = false;
  try {
    await runGitExecutable(["init", "--bare", repositoryPath]);
    await configureRepository(repositoryPath, resolvedRoot);
    await ensureDiffIgnore(resolvedRoot);
    await syncDiffIgnore(resolvedRoot);
    await stageBaseline(resolvedRoot);
    await writeProjectMetadata(resolvedRoot, storeId);
    initialized = true;
    return storeId;
  } finally {
    if (!initialized) {
      await storeClaim.cleanupAfterFailure();
    }
  }
}

// Stages every working-tree file that survives info/exclude (= .diffignore + mandatory floor),
// without honoring the project's own .gitignore, skipping binary/oversized files. `ls-files
// --others` skips excluded folders natively, so node_modules is never walked.
async function stageBaseline(rootPath: string): Promise<void> {
  const candidates = await listUntrackedUnignored(rootPath);
  if (candidates.size === 0) {
    return;
  }
  const trackable: string[] = [];
  for (const relativePath of candidates) {
    // Screen symlinked paths out first (lstat before stat/open) so the baseline never follows a
    // symlink to capture outside content — the same "ignore" policy the scan uses.
    const currentPath = await resolveSafeProjectPathOrUndefined(rootPath, relativePath);
    if (currentPath === undefined) {
      continue;
    }
    if (await isTrackableTextFile(currentPath)) {
      trackable.push(relativePath);
    }
  }
  if (trackable.length === 0) {
    return;
  }
  await runProjectGit(rootPath, ["update-index", "--add", "-z", "--stdin"], {
    input: Buffer.from(`${trackable.join("\0")}\0`),
  });
}

async function configureRepository(repositoryPath: string, rootPath: string): Promise<void> {
  await runGitRepository(repositoryPath, rootPath, ["config", "core.autocrlf", "false"]);
  await runGitRepository(repositoryPath, rootPath, ["config", "core.filemode", "false"]);
  await runGitRepository(repositoryPath, rootPath, ["config", "core.fsmonitor", "false"]);
  await mkdir(join(repositoryPath, "info"), { recursive: true });
  await writeFile(
    join(repositoryPath, "info", "attributes"),
    "* -text -filter -ident diff\n",
    "utf8",
  );
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
