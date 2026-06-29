import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import {
  isMissingPathError,
  isNoSuchProcessError,
  isPathExistsError,
} from "../errors/fs-errors.ts";

interface LockMetadata {
  hostname: string;
  pid: number;
  startedAt: string;
  token: string;
}

const incompleteLockGraceMilliseconds = 30_000;

export interface ProjectOperationLease {
  release(): Promise<void>;
}

export function operationLockPath(rootPath: string): string {
  return join(resolve(rootPath), ".inlinediff", "operation.lock");
}

export async function tryAcquireProjectOperationLock(
  rootPath: string,
): Promise<ProjectOperationLease | undefined> {
  const path = operationLockPath(rootPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await isRecoveryInProgress(path)) {
      return undefined;
    }
    const metadata = createLockMetadata();
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify(metadata), "utf8");
        await handle.sync();
      } catch (error) {
        // "wx" gave us exclusive ownership of this file, so removing it unconditionally only ever
        // deletes our own lock. A token-checked delete would instead leak the file here, because a
        // failed write may have left no readable token to match. Swallow any cleanup failure so the
        // original write error is the one surfaced (a leftover incomplete lock is reclaimed later).
        await handle.close();
        try {
          await rm(path, { force: true });
        } catch {}
        throw error;
      }
      await handle.close();
      return {
        release: () => releaseLock(path, metadata),
      };
    } catch (error) {
      if (!isPathExistsError(error)) {
        throw error;
      }
      if (!(await removeStaleLock(path))) {
        return undefined;
      }
    }
  }
  return undefined;
}

function createLockMetadata(): LockMetadata {
  return {
    hostname: hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
}

async function removeStaleLock(path: string): Promise<boolean> {
  // A recovery guard serializes stale-lock cleanup across VS Code windows. The
  // token is read twice so a newly acquired operation lock is not removed.
  const guard = await tryAcquireRecoveryGuard(path);
  if (guard === undefined) {
    return false;
  }
  try {
    const metadata = await readLockMetadata(path);
    if (metadata === undefined) {
      return removeOldIncompleteLock(path);
    }
    // Only single-machine use is supported, so a lock owned by another host is deliberately left
    // in place: we cannot tell whether that host's process is alive. A same-host lock from a dead
    // process is reclaimed here, so normal single-machine use is never blocked permanently.
    if (metadata.hostname !== hostname() || isProcessAlive(metadata.pid)) {
      return false;
    }

    const latest = await readLockMetadata(path);
    if (latest?.token !== metadata.token) {
      return false;
    }
    await rm(path, { force: true });
    return true;
  } finally {
    await guard.release();
  }
}

async function removeOldIncompleteLock(path: string): Promise<boolean> {
  let modifiedAt: number;
  try {
    modifiedAt = (await stat(path)).mtimeMs;
  } catch (error) {
    return isMissingPathError(error);
  }
  if (Date.now() - modifiedAt < incompleteLockGraceMilliseconds) {
    return false;
  }
  if ((await readLockMetadata(path)) !== undefined) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

async function releaseLock(path: string, owner: LockMetadata): Promise<void> {
  const metadata = await readLockMetadata(path);
  if (metadata?.token === owner.token) {
    await rm(path, { force: true });
  }
}

async function tryAcquireRecoveryGuard(path: string): Promise<ProjectOperationLease | undefined> {
  const guardPath = recoveryGuardPath(path);
  const metadata = createLockMetadata();
  try {
    const handle = await open(guardPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(metadata), "utf8");
      await handle.sync();
    } catch (error) {
      // As above: clean up our own freshly created guard but let the original write error surface.
      await handle.close();
      try {
        await rm(guardPath, { force: true });
      } catch {}
      throw error;
    }
    await handle.close();
    return {
      release: () => releaseLock(guardPath, metadata),
    };
  } catch (error) {
    if (isPathExistsError(error)) {
      return undefined;
    }
    throw error;
  }
}

function recoveryGuardPath(path: string): string {
  return `${path}.recovery`;
}

// A recovery guard is only ever held for a few filesystem operations, so a guard
// older than the grace window must belong to a crashed window. Reclaim it instead
// of treating it as an in-progress recovery, otherwise it blocks the project forever.
async function isRecoveryInProgress(path: string): Promise<boolean> {
  const guardPath = recoveryGuardPath(path);
  let modifiedAt: number;
  try {
    modifiedAt = (await stat(guardPath)).mtimeMs;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
  if (Date.now() - modifiedAt < incompleteLockGraceMilliseconds) {
    return true;
  }
  await rm(guardPath, { force: true });
  return false;
}

async function readLockMetadata(path: string): Promise<LockMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockMetadata>;
    if (
      typeof value.hostname !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.startedAt !== "string" ||
      typeof value.token !== "string"
    ) {
      return undefined;
    }
    return value as LockMetadata;
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}
