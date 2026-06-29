import { describe, expect, test } from "bun:test";
import { ChangedFilesStore } from "../../src/views/changed-files-store.ts";

describe("ChangedFilesStore", () => {
  test("retainProjects removes projects whose root is no longer retained, notifying once", () => {
    const store = new ChangedFilesStore();
    store.replaceProject("C:/workspace/a", [{ kind: "modified", relativePath: "a.ts" }]);
    store.replaceProject("C:/workspace/b", [{ kind: "modified", relativePath: "b.ts" }]);
    let notifications = 0;
    store.onDidChange(() => {
      notifications += 1;
    });

    store.retainProjects(["C:/workspace/a"]);

    expect(store.snapshot().map((snapshot) => snapshot.rootPath)).toEqual(["C:/workspace/a"]);
    expect(notifications).toBe(1);
  });

  test("retainProjects does not notify when nothing is removed", () => {
    const store = new ChangedFilesStore();
    store.replaceProject("C:/workspace/a", [{ kind: "modified", relativePath: "a.ts" }]);
    let notifications = 0;
    store.onDidChange(() => {
      notifications += 1;
    });

    store.retainProjects(["C:/workspace/a", "C:/workspace/never-scanned"]);

    expect(notifications).toBe(0);
  });

  test("publishes project entries and removes clean files", () => {
    const store = new ChangedFilesStore();
    store.replaceProject("C:/workspace/app", [
      { kind: "modified", relativePath: "src/a.ts" },
      { kind: "deleted", relativePath: "src/b.ts" },
    ]);

    store.updateFile("C:/workspace/app", { kind: "added", relativePath: "src/c.ts" });
    store.updateFile("C:/workspace/app", { kind: "clean", relativePath: "src/a.ts" });

    expect(store.snapshot()).toEqual([
      {
        files: [
          { kind: "deleted", relativePath: "src/b.ts" },
          { kind: "added", relativePath: "src/c.ts" },
        ],
        rootPath: "C:/workspace/app",
        scanState: "idle",
      },
    ]);
  });

  test("updates multiple files with one change notification", () => {
    const store = new ChangedFilesStore();
    let notifications = 0;
    store.replaceProject("C:/workspace/app", [
      { kind: "modified", relativePath: "src/a.ts" },
      { kind: "modified", relativePath: "src/b.ts" },
    ]);
    store.onDidChange(() => {
      notifications += 1;
    });

    store.updateFiles("C:/workspace/app", [
      { kind: "clean", relativePath: "src/a.ts" },
      { kind: "clean", relativePath: "src/b.ts" },
    ]);

    expect(notifications).toBe(1);
    expect(store.snapshot()[0]?.files).toEqual([]);
  });

  test("tracks changed volume since the last full scan", () => {
    const store = new ChangedFilesStore({
      maxChangedEventsSinceFullScan: 3,
      maxChangedFilesSinceFullScan: 2,
    });
    store.replaceProject("C:/workspace/app", []);

    expect(store.recordFileEvent("C:/workspace/app", "a.ts")).toEqual({ escalate: false });
    expect(store.recordFileEvent("C:/workspace/app", "b.ts")).toEqual({ escalate: true });
  });

  test("invalidates stale file refresh generations", () => {
    const store = new ChangedFilesStore();
    store.replaceProject("C:/workspace/app", [{ kind: "modified", relativePath: "src/a.ts" }]);
    const stale = store.beginFileRefresh("C:/workspace/app", "src/a.ts");
    store.beginProjectScan("C:/workspace/app", "background");
    store.updateFileIfCurrent(stale, { kind: "clean", relativePath: "src/a.ts" });

    expect(store.snapshot()[0]?.files).toEqual([{ kind: "modified", relativePath: "src/a.ts" }]);
  });
});
