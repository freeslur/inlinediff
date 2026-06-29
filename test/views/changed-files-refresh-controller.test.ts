import { describe, expect, test } from "bun:test";
import { ChangedFilesRefreshController } from "../../src/views/changed-files-refresh-controller.ts";
import { ChangedFilesStore, type ScannedFileLike } from "../../src/views/changed-files-store.ts";

describe("ChangedFilesRefreshController", () => {
  test("foreground refresh discovers projects and replaces store entries", async () => {
    const store = new ChangedFilesStore();
    const controller = new ChangedFilesRefreshController(store, {
      classifyFile: failClassifyFile,
      scanProject: async () => [{ kind: "modified", relativePath: "src/app.ts" }],
    });

    await controller.refreshWorkspaceForeground(["C:/workspace/app"]);

    expect(store.snapshot()).toEqual([
      {
        files: [{ kind: "modified", relativePath: "src/app.ts" }],
        rootPath: "C:/workspace/app",
        scanState: "idle",
      },
    ]);
  });

  test("ordinary file events refresh only the changed file below threshold", async () => {
    const store = new ChangedFilesStore({
      maxChangedEventsSinceFullScan: 10,
      maxChangedFilesSinceFullScan: 10,
    });
    store.replaceProject("C:/workspace/app", []);
    const calls: string[] = [];
    const controller = new ChangedFilesRefreshController(store, {
      classifyFile: async (rootPath, relativePath) => {
        calls.push(`${rootPath}:${relativePath}`);
        return { kind: "added", relativePath };
      },
      scanProject: failScanProject,
    });

    await controller.handleFileEvent("C:/workspace/app", "src/new.ts");

    expect(calls).toEqual(["C:/workspace/app:src/new.ts"]);
    expect(store.snapshot()[0]?.files).toEqual([{ kind: "added", relativePath: "src/new.ts" }]);
  });

  test(".diffignore changes escalate to a background project scan below threshold", async () => {
    const rootPath = "C:/workspace/app";
    const store = new ChangedFilesStore({
      maxChangedEventsSinceFullScan: 10,
      maxChangedFilesSinceFullScan: 10,
    });
    store.replaceProject(rootPath, [{ kind: "modified", relativePath: "visible.ts" }]);
    let scanCalls = 0;
    const classifiedFiles: string[] = [];
    const controller = new ChangedFilesRefreshController(store, {
      classifyFile: async (_rootPath, relativePath) => {
        classifiedFiles.push(relativePath);
        return { kind: "modified", relativePath };
      },
      scanProject: async () => {
        scanCalls += 1;
        return [{ kind: "added", relativePath: "now-visible.log" }];
      },
    });

    await controller.handleFileEvent(rootPath, ".diffignore");

    expect(scanCalls).toBe(1);
    expect(classifiedFiles).toEqual([]);
    expect(store.snapshot()[0]?.files).toEqual([
      { kind: "added", relativePath: "now-visible.log" },
    ]);
  });

  test("unique file threshold escalates to a background project scan", async () => {
    const store = new ChangedFilesStore({
      maxChangedEventsSinceFullScan: 10,
      maxChangedFilesSinceFullScan: 2,
    });
    store.replaceProject("C:/workspace/app", [{ kind: "modified", relativePath: "old.ts" }]);
    let scanCalls = 0;
    const controller = new ChangedFilesRefreshController(store, {
      classifyFile: async (_rootPath, relativePath) => ({ kind: "added", relativePath }),
      scanProject: async () => {
        scanCalls += 1;
        return [{ kind: "modified", relativePath: "rescanned.ts" }];
      },
    });

    await controller.handleFileEvent("C:/workspace/app", "first.ts");
    await controller.handleFileEvent("C:/workspace/app", "second.ts");

    expect(scanCalls).toBe(1);
    expect(store.snapshot()[0]?.files).toEqual([
      { kind: "modified", relativePath: "rescanned.ts" },
    ]);
  });

  test("event count threshold escalates repeated changes to a background project scan", async () => {
    const store = new ChangedFilesStore({
      maxChangedEventsSinceFullScan: 3,
      maxChangedFilesSinceFullScan: 10,
    });
    store.replaceProject("C:/workspace/app", []);
    let scanCalls = 0;
    const controller = new ChangedFilesRefreshController(store, {
      classifyFile: async (_rootPath, relativePath) => ({ kind: "modified", relativePath }),
      scanProject: async () => {
        scanCalls += 1;
        return [{ kind: "modified", relativePath: "after-burst.ts" }];
      },
    });

    await controller.handleFileEvent("C:/workspace/app", "same.ts");
    await controller.handleFileEvent("C:/workspace/app", "same.ts");
    await controller.handleFileEvent("C:/workspace/app", "same.ts");

    expect(scanCalls).toBe(1);
    expect(store.snapshot()[0]?.files).toEqual([
      { kind: "modified", relativePath: "after-burst.ts" },
    ]);
  });

  test("stale incremental results do not overwrite a later project scan", async () => {
    const store = new ChangedFilesStore({
      maxChangedEventsSinceFullScan: 10,
      maxChangedFilesSinceFullScan: 10,
    });
    store.replaceProject("C:/workspace/app", [{ kind: "modified", relativePath: "before.ts" }]);
    const fileClassification = createDeferred<ScannedFileLike>();
    const controller = new ChangedFilesRefreshController(store, {
      classifyFile: () => fileClassification.promise,
      scanProject: async () => [{ kind: "modified", relativePath: "scan.ts" }],
    });

    const fileRefresh = controller.handleFileEvent("C:/workspace/app", "late.ts");
    await controller.refreshProjectBackground("C:/workspace/app");
    fileClassification.resolve({ kind: "added", relativePath: "late.ts" });
    await fileRefresh;

    expect(store.snapshot()[0]?.files).toEqual([{ kind: "modified", relativePath: "scan.ts" }]);
  });

  test("marks bulk-succeeded files clean without scanning the project again", () => {
    const rootPath = "C:/workspace/project";
    const store = new ChangedFilesStore();
    store.replaceProject(rootPath, [
      { kind: "modified", relativePath: "accepted.ts" },
      { kind: "modified", relativePath: "failed.ts" },
    ]);
    let scanCalls = 0;
    const controller = new ChangedFilesRefreshController(store, {
      classifyFile: async () => ({ kind: "clean", relativePath: "unused.ts" }),
      scanProject: async () => {
        scanCalls += 1;
        return [];
      },
    });

    controller.markFilesClean(rootPath, ["accepted.ts"]);

    expect(scanCalls).toBe(0);
    expect(store.snapshot()).toEqual([
      {
        files: [{ kind: "modified", relativePath: "failed.ts" }],
        rootPath,
        scanState: "idle",
      },
    ]);
  });

  test("returns a background scan to idle when scanning fails", async () => {
    const rootPath = "C:/workspace/project";
    const store = new ChangedFilesStore();
    store.replaceProject(rootPath, [{ kind: "modified", relativePath: "existing.ts" }]);
    const controller = new ChangedFilesRefreshController(store, {
      classifyFile: failClassifyFile,
      scanProject: async () => {
        throw new Error("scan failed");
      },
    });

    await expect(controller.refreshProjectBackground(rootPath)).rejects.toThrow("scan failed");

    expect(store.snapshot()).toEqual([
      {
        files: [{ kind: "modified", relativePath: "existing.ts" }],
        rootPath,
        scanState: "idle",
      },
    ]);
  });

  test("returns a foreground scan to idle when scanning fails", async () => {
    const rootPath = "C:/workspace/project";
    const store = new ChangedFilesStore();
    const controller = new ChangedFilesRefreshController(store, {
      classifyFile: failClassifyFile,
      scanProject: async () => {
        throw new Error("scan failed");
      },
    });

    await expect(controller.refreshWorkspaceForeground([rootPath])).rejects.toThrow("scan failed");

    expect(store.snapshot()).toEqual([
      {
        files: [],
        rootPath,
        scanState: "idle",
      },
    ]);
  });
});

function failClassifyFile(): Promise<ScannedFileLike> {
  throw new Error("classifyFile should not be called.");
}

function failScanProject(): Promise<ScannedFileLike[]> {
  throw new Error("scanProject should not be called.");
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
