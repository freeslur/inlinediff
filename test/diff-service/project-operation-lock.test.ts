import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  operationLockPath,
  tryAcquireProjectOperationLock,
} from "../../src/diff-service/project-operation-lock.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-operation-lock-test-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".inlinediff"));
  return root;
}

describe("project operation lock", () => {
  test("allows only one operation lease per project", async () => {
    const root = await createProject();
    const first = await tryAcquireProjectOperationLock(root);

    expect(first).toBeDefined();
    expect(await tryAcquireProjectOperationLock(root)).toBeUndefined();

    await first?.release();
    const second = await tryAcquireProjectOperationLock(root);
    expect(second).toBeDefined();
    await second?.release();
  });

  test("recovers a lock owned by a process that has exited", async () => {
    const root = await createProject();
    const deadPid = await createDeadProcessId();
    await writeFile(
      operationLockPath(root),
      JSON.stringify({
        hostname: hostname(),
        pid: deadPid,
        startedAt: new Date().toISOString(),
        token: "stale",
      }),
      "utf8",
    );

    const lease = await tryAcquireProjectOperationLock(root);

    expect(lease).toBeDefined();
    await lease?.release();
  });

  test("recovers an old lock with incomplete metadata", async () => {
    const root = await createProject();
    const path = operationLockPath(root);
    await writeFile(path, "{", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);

    const lease = await tryAcquireProjectOperationLock(root);

    expect(lease).toBeDefined();
    await lease?.release();
  });

  test("allows only one lease while concurrent callers recover an incomplete lock", async () => {
    const root = await createProject();
    const path = operationLockPath(root);
    await writeFile(path, "{", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const lease = await tryAcquireProjectOperationLock(root);
        if (lease === undefined) {
          return;
        }
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(20);
        active -= 1;
        await lease.release();
      }),
    );

    expect(maximumActive).toBe(1);
  });
});

function createDeadProcessId(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
    child.on("error", reject);
    child.on("close", () => {
      if (child.pid === undefined) {
        reject(new Error("Expected a child process ID."));
        return;
      }
      resolvePromise(child.pid);
    });
  });
}
