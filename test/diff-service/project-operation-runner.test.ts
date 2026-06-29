import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectOperationCoordinator } from "../../src/diff-service/project-operation-coordinator.ts";
import { tryAcquireProjectOperationLock } from "../../src/diff-service/project-operation-lock.ts";
import { ProjectOperationRunner } from "../../src/diff-service/project-operation-runner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-operation-runner-test-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".inlinediff"));
  return root;
}

describe("ProjectOperationRunner", () => {
  test("releases busy state and project lock before notify resolves", async () => {
    const root = await createProject();
    const coordinator = new ProjectOperationCoordinator();
    const runner = new ProjectOperationRunner(coordinator);
    let releaseNotify: (() => void) | undefined;
    let finishNotify: (() => void) | undefined;
    const notifyFinished = new Promise<void>((resolve) => {
      finishNotify = resolve;
    });
    const notifyStarted = new Promise<void>((resolve) => {
      void runner.run({
        apply: async () => undefined,
        name: "Accept All",
        notify: async () => {
          resolve();
          await new Promise<void>((notifyResolve) => {
            releaseNotify = notifyResolve;
          });
          finishNotify?.();
        },
        rootPath: root,
      });
    });

    await notifyStarted;

    expect(coordinator.state.isBusy(root)).toBe(false);
    const lease = await tryAcquireProjectOperationLock(root);
    expect(lease).toBeDefined();
    await lease?.release();

    releaseNotify?.();
    await notifyFinished;
  });

  test("returns before notify resolves when notify is deferred", async () => {
    const root = await createProject();
    const runner = new ProjectOperationRunner();
    let releaseNotify: (() => void) | undefined;
    let finishNotify: (() => void) | undefined;
    const notifyFinished = new Promise<void>((resolve) => {
      finishNotify = resolve;
    });

    const run = runner.run({
      apply: async () => undefined,
      name: "Accept All",
      notify: async () => {
        await new Promise<void>((resolve) => {
          releaseNotify = resolve;
        });
        finishNotify?.();
      },
      rootPath: root,
    });
    let completed = false;
    const completedRun = run.then((value) => {
      completed = true;
      return value;
    });

    await waitFor(() => releaseNotify !== undefined);
    await waitFor(() => completed);

    expect(await completedRun).toBe(true);
    releaseNotify?.();
    await notifyFinished;
  });

  test("does not run notify when the project is already busy", async () => {
    const root = await createProject();
    const coordinator = new ProjectOperationCoordinator();
    const runner = new ProjectOperationRunner(coordinator);
    let releaseFirst: (() => void) | undefined;
    const first = runner.run({
      apply: () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
      name: "Accept File",
      rootPath: root,
    });
    await waitFor(() => releaseFirst !== undefined);
    let notified = false;

    const ran = await runner.run({
      apply: async () => undefined,
      name: "Accept File",
      notify: async () => {
        notified = true;
      },
      rootPath: root,
    });

    expect(ran).toBe(false);
    expect(notified).toBe(false);
    releaseFirst?.();
    expect(await first).toBe(true);
  });

  test("runs prepare, apply, and refresh under lock before notify", async () => {
    const root = await createProject();
    const runner = new ProjectOperationRunner();
    const events: string[] = [];
    let finishNotify: (() => void) | undefined;
    const notifyFinished = new Promise<void>((resolve) => {
      finishNotify = resolve;
    });
    const assertLocked = async (stage: string): Promise<void> => {
      const lease = await tryAcquireProjectOperationLock(root);
      await lease?.release();
      if (lease !== undefined) {
        throw new Error(`${stage} ran outside the project operation lock.`);
      }
    };

    const ran = await runner.run({
      apply: async () => {
        events.push("apply");
        await assertLocked("apply");
      },
      name: "Reject Change",
      notify: async () => {
        events.push("notify");
        const lease = await tryAcquireProjectOperationLock(root);
        expect(lease).toBeDefined();
        await lease?.release();
        finishNotify?.();
      },
      prepare: async () => {
        events.push("prepare");
        await assertLocked("prepare");
      },
      refresh: async () => {
        events.push("refresh");
        await assertLocked("refresh");
      },
      rootPath: root,
    });

    expect(ran).toBe(true);
    await waitFor(() => events.includes("notify"));
    await notifyFinished;
    expect(events).toEqual(["prepare", "apply", "refresh", "notify"]);
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
