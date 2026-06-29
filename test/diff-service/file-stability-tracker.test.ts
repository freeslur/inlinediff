import { describe, expect, test } from "bun:test";
import type { FileContentRevision } from "../../src/diff-service/file-content-revision.ts";
import {
  FileStabilityTracker,
  type StabilityCheck,
} from "../../src/diff-service/file-stability-tracker.ts";

function existingRevision(hash: string, size = 1n): FileContentRevision {
  return {
    birthtimeNs: 1n,
    ctimeNs: 1n,
    dev: 1n,
    exists: true,
    gid: 1n,
    hash,
    ino: 1n,
    mode: 0o100644n,
    mtimeNs: 1n,
    nlink: 1n,
    size,
    uid: 1n,
  };
}

describe("FileStabilityTracker", () => {
  test("keeps notifying listeners when one listener throws", async () => {
    const scheduledChecks: StabilityCheck[] = [];
    const received: boolean[] = [];
    const tracker = new FileStabilityTracker({
      readRevision: async () => existingRevision("stable"),
      schedule: (check) => scheduledChecks.push(check),
    });
    tracker.onDidChangeStatus(() => {
      throw new Error("listener boom");
    });
    tracker.onDidChangeStatus((event) => {
      received.push(event.changing);
    });

    expect(() => tracker.markChanged("C:/project", "src/file.ts")).not.toThrow();
    expect(received).toEqual([true]);

    await scheduledChecks.shift()?.();

    expect(received).toEqual([true, false]);
  });

  test("marks a changed file as stable after the scheduled revision check completes", async () => {
    const scheduledChecks: StabilityCheck[] = [];
    const tracker = new FileStabilityTracker({
      readRevision: async () => existingRevision("stable"),
      schedule: (check) => scheduledChecks.push(check),
    });

    tracker.markChanged("C:/project", "src/file.ts");

    expect(tracker.isChanging("C:/project", "src/file.ts")).toBe(true);

    await scheduledChecks.shift()?.();

    expect(tracker.isChanging("C:/project", "src/file.ts")).toBe(false);
  });

  test("notifies listeners when file changing state changes", async () => {
    const scheduledChecks: StabilityCheck[] = [];
    const notifications: boolean[] = [];
    const tracker = new FileStabilityTracker({
      readRevision: async () => existingRevision("stable"),
      schedule: (check) => scheduledChecks.push(check),
    });
    tracker.onDidChangeStatus((event) => {
      notifications.push(event.changing);
    });

    tracker.markChanged("C:/project", "src/file.ts");
    await scheduledChecks.shift()?.();

    expect(notifications).toEqual([true, false]);
  });

  test("stops notifying a disposed status listener", async () => {
    const scheduledChecks: StabilityCheck[] = [];
    const notifications: boolean[] = [];
    const tracker = new FileStabilityTracker({
      readRevision: async () => existingRevision("stable"),
      schedule: (check) => scheduledChecks.push(check),
    });
    const dispose = tracker.onDidChangeStatus((event) => {
      notifications.push(event.changing);
    });

    dispose();
    tracker.markChanged("C:/project", "src/file.ts");
    await scheduledChecks.shift()?.();

    expect(notifications).toEqual([]);
  });

  test("does not let an older debounce check clear a newer file change", async () => {
    const scheduledChecks: StabilityCheck[] = [];
    const tracker = new FileStabilityTracker({
      readRevision: async () => existingRevision("latest"),
      schedule: (check) => scheduledChecks.push(check),
    });

    tracker.markChanged("C:/project", "src/file.ts");
    tracker.markChanged("C:/project", "src/file.ts");

    await scheduledChecks.shift()?.();

    expect(tracker.isChanging("C:/project", "src/file.ts")).toBe(true);

    await scheduledChecks.shift()?.();

    expect(tracker.isChanging("C:/project", "src/file.ts")).toBe(false);
  });

  test("keeps a file changing and retries when revision reading fails", async () => {
    const scheduledChecks: StabilityCheck[] = [];
    const revisions: (Error | FileContentRevision)[] = [
      new Error("File changed while reading"),
      existingRevision("stable-after-retry"),
    ];
    const tracker = new FileStabilityTracker({
      readRevision: async () => {
        const next = revisions.shift();
        if (next === undefined) {
          throw new Error("Expected a queued revision.");
        }
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
      schedule: (check) => scheduledChecks.push(check),
    });

    tracker.markChanged("C:/project", "src/file.ts");
    await scheduledChecks.shift()?.();

    expect(tracker.isChanging("C:/project", "src/file.ts")).toBe(true);
    expect(scheduledChecks).toHaveLength(1);

    await scheduledChecks.shift()?.();

    expect(tracker.isChanging("C:/project", "src/file.ts")).toBe(false);
  });

  test("treats a missing file revision as stable after debounce", async () => {
    const scheduledChecks: StabilityCheck[] = [];
    const missingRevision: FileContentRevision = { exists: false };
    const tracker = new FileStabilityTracker({
      readRevision: async () => missingRevision,
      schedule: (check) => scheduledChecks.push(check),
    });

    tracker.markChanged("C:/project", "deleted.ts");
    await scheduledChecks.shift()?.();

    expect(tracker.isChanging("C:/project", "deleted.ts")).toBe(false);
  });

  test("does not clear changing state before a scheduled check runs", () => {
    const tracker = new FileStabilityTracker({
      readRevision: async () => existingRevision("unused"),
      schedule: () => undefined,
    });

    tracker.markChanged("C:/project", "src/file.ts");

    expect(tracker.isChanging("C:/project", "src/file.ts")).toBe(true);
  });
});
