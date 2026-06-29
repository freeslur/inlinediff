import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectOperationCoordinator } from "../../src/diff-service/project-operation-coordinator.ts";
import { operationLockPath } from "../../src/diff-service/project-operation-lock.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-operation-coordinator-test-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".inlinediff"));
  return root;
}

describe("ProjectOperationCoordinator", () => {
  test("allows only one operation in the same coordinator and project", async () => {
    const root = await createProject();
    const coordinator = new ProjectOperationCoordinator();
    let releaseFirst: (() => void) | undefined;
    const first = coordinator.run(
      root,
      { hunkId: "hunk", relativePath: "file.ts" },
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    await waitFor(() => releaseFirst !== undefined);

    expect(await coordinator.run(root, undefined, async () => undefined)).toBe(false);
    expect(coordinator.state.isPendingHunk(root, "file.ts", "hunk")).toBe(true);

    releaseFirst?.();
    expect(await first).toBe(true);
    expect(coordinator.state.isBusy(root)).toBe(false);
  });

  test("allows only one operation across coordinator instances", async () => {
    const root = await createProject();
    const firstCoordinator = new ProjectOperationCoordinator();
    const secondCoordinator = new ProjectOperationCoordinator();
    let releaseFirst: (() => void) | undefined;
    const first = firstCoordinator.run(
      root,
      undefined,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    await waitFor(() => releaseFirst !== undefined);

    expect(await secondCoordinator.run(root, undefined, async () => undefined)).toBe(false);

    releaseFirst?.();
    expect(await first).toBe(true);
  });

  test("releases the project after an operation fails", async () => {
    const root = await createProject();
    const coordinator = new ProjectOperationCoordinator();

    await expect(
      coordinator.run(root, undefined, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");

    expect(coordinator.state.isBusy(root)).toBe(false);
    expect(await coordinator.run(root, undefined, async () => undefined)).toBe(true);
  });

  test("allows operations in different projects", async () => {
    const firstRoot = await createProject();
    const secondRoot = await createProject();
    const coordinator = new ProjectOperationCoordinator();
    let releaseFirst: (() => void) | undefined;
    const first = coordinator.run(
      firstRoot,
      undefined,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await waitFor(() => releaseFirst !== undefined);

    expect(await coordinator.run(secondRoot, undefined, async () => undefined)).toBe(true);

    releaseFirst?.();
    expect(await first).toBe(true);
  });

  test("allows only one operation across extension host processes", async () => {
    const root = await createProject();
    const gatePath = join(root, "start-process-operations");
    const processCount = 4;
    const processes = Array.from({ length: processCount }, (_, index) =>
      runCoordinatorProcess(root, gatePath, join(root, `process-${index}.txt`)),
    );

    await Bun.sleep(50);
    await Bun.write(gatePath, "start");
    const exitCodes = await Promise.all(processes);

    expect(exitCodes.filter((code) => code === 0)).toHaveLength(1);
    expect(exitCodes.filter((code) => code === 3)).toHaveLength(processCount - 1);
  });

  test("runs after recovering a project lock left by an exited extension host", async () => {
    const root = await createProject();
    const deadPid = await createDeadProcessId();
    await Bun.write(
      operationLockPath(root),
      JSON.stringify({
        hostname: hostname(),
        pid: deadPid,
        startedAt: new Date().toISOString(),
        token: "dead-extension-host",
      }),
    );
    const coordinator = new ProjectOperationCoordinator();
    let completed = false;

    const ran = await coordinator.run(root, undefined, async () => {
      completed = true;
    });

    expect(ran).toBe(true);
    expect(completed).toBe(true);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for condition.");
}

function runCoordinatorProcess(
  rootPath: string,
  gatePath: string,
  markerPath: string,
): Promise<number | null> {
  const coordinatorUrl = pathToFileURL(
    join(process.cwd(), "src", "diff-service", "project-operation-coordinator.ts"),
  ).href;
  const script = `
    import { ProjectOperationCoordinator } from ${JSON.stringify(coordinatorUrl)};
    while (!(await Bun.file(${JSON.stringify(gatePath)}).exists())) {
      await Bun.sleep(1);
    }
    const ran = await new ProjectOperationCoordinator().run(
      ${JSON.stringify(rootPath)},
      undefined,
      async () => {
        await Bun.write(${JSON.stringify(markerPath)}, "running");
        await Bun.sleep(300);
      },
    );
    process.exit(ran ? 0 : 3);
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["-e", script], { windowsHide: true });
    child.on("error", reject);
    child.on("close", resolvePromise);
  });
}

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
