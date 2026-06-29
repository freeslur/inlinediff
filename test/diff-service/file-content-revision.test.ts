import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFileContentRevision,
  readFileContentSnapshot,
  revisionsEqual,
} from "../../src/diff-service/file-content-revision.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-file-revision-test-"));
  temporaryDirectories.push(root);
  return root;
}

describe("file content revision", () => {
  test("distinguishes missing and existing files", async () => {
    const root = await createDirectory();
    const path = join(root, "file.ts");

    const missing = await readFileContentRevision(path);
    await writeFile(path, "content", "utf8");
    const existing = await readFileContentRevision(path);

    expect(missing).toEqual({ exists: false });
    expect(existing.exists).toBe(true);
    expect(revisionsEqual(missing, existing)).toBe(false);
  });

  test("compares file identity separately from file content", async () => {
    const root = await createDirectory();
    const firstPath = join(root, "first.ts");
    const secondPath = join(root, "second.ts");
    await writeFile(firstPath, "same", "utf8");
    await writeFile(secondPath, "same", "utf8");

    const first = await readFileContentRevision(firstPath);
    const second = await readFileContentRevision(secondPath);

    expect(revisionsEqual(first, second)).toBe(false);
  });

  test("detects content changes even when file size stays the same", async () => {
    const root = await createDirectory();
    const path = join(root, "file.ts");
    await writeFile(path, "first", "utf8");
    const before = await readFileContentRevision(path);
    await writeFile(path, "other", "utf8");
    const after = await readFileContentRevision(path);

    expect(revisionsEqual(before, after)).toBe(false);
  });

  test("captures file content with the revision it describes", async () => {
    const root = await createDirectory();
    const path = join(root, "file.ts");
    await writeFile(path, "captured", "utf8");

    const snapshot = await readFileContentSnapshot(path);

    expect(snapshot.revision.exists).toBe(true);
    expect(snapshot.content).toEqual(Buffer.from("captured"));
    expect(revisionsEqual(snapshot.revision, await readFileContentRevision(path))).toBe(true);
  });
});
