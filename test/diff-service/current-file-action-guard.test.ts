import { describe, expect, test } from "bun:test";
import {
  CurrentFileActionGuard,
  CurrentFileDirtyError,
  CurrentFileStillChangingError,
} from "../../src/diff-service/current-file-action-guard.ts";
import type { FileContentRevision } from "../../src/diff-service/file-content-revision.ts";

const stableRevision: FileContentRevision = {
  birthtimeNs: 1n,
  ctimeNs: 1n,
  dev: 1n,
  exists: true,
  gid: 1n,
  hash: "stable",
  ino: 1n,
  mode: 0o100644n,
  mtimeNs: 1n,
  nlink: 1n,
  size: 6n,
  uid: 1n,
};

describe("CurrentFileActionGuard", () => {
  test("blocks actions while the file is still changing", async () => {
    let read = false;
    const guard = new CurrentFileActionGuard({
      isChanging: () => true,
      isDirty: () => false,
      readRevision: async () => {
        read = true;
        return stableRevision;
      },
    });

    await expect(guard.assertReady("C:/project", "file.ts")).rejects.toBeInstanceOf(
      CurrentFileStillChangingError,
    );
    expect(read).toBe(false);
  });

  test("blocks actions while the current document is dirty", async () => {
    let read = false;
    const guard = new CurrentFileActionGuard({
      isChanging: () => false,
      isDirty: () => true,
      readRevision: async () => {
        read = true;
        return stableRevision;
      },
    });

    await expect(guard.assertReady("C:/project", "file.ts")).rejects.toBeInstanceOf(
      CurrentFileDirtyError,
    );
    expect(read).toBe(false);
  });

  test("returns the latest revision when a file is stable and clean", async () => {
    const guard = new CurrentFileActionGuard({
      isChanging: () => false,
      isDirty: () => false,
      readRevision: async () => stableRevision,
    });

    await expect(guard.assertReady("C:/project", "file.ts")).resolves.toEqual(stableRevision);
  });
});
