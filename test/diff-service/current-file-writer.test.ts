import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CurrentFileRevisionConflictError,
  deleteCurrentFile,
  writeCurrentFile,
} from "../../src/diff-service/current-file-writer.ts";
import { readFileContentRevision } from "../../src/diff-service/file-content-revision.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-current-file-writer-test-"));
  temporaryDirectories.push(root);
  return root;
}

describe("current file writer", () => {
  test("writes replacement content when the expected current revision is unchanged", async () => {
    const root = await createProject();
    const currentPath = join(root, "file.ts");
    await writeFile(currentPath, "current", "utf8");
    const expected = await readFileContentRevision(currentPath);

    const revision = await writeCurrentFile(root, "file.ts", Buffer.from("baseline"), expected);

    expect(await readFile(currentPath, "utf8")).toBe("baseline");
    expect(revision.exists).toBe(true);
    if (revision.exists) {
      expect(revision.size).toBe(8n);
    }
  });

  test("refuses to write replacement content after the current file changes", async () => {
    const root = await createProject();
    const currentPath = join(root, "file.ts");
    await writeFile(currentPath, "current", "utf8");
    const expected = await readFileContentRevision(currentPath);
    await writeFile(currentPath, "external", "utf8");

    await expect(
      writeCurrentFile(root, "file.ts", Buffer.from("baseline"), expected),
    ).rejects.toBeInstanceOf(CurrentFileRevisionConflictError);

    expect(await readFile(currentPath, "utf8")).toBe("external");
  });

  test("deletes the current file when the expected revision is unchanged", async () => {
    const root = await createProject();
    const currentPath = join(root, "added.ts");
    await writeFile(currentPath, "added", "utf8");
    const expected = await readFileContentRevision(currentPath);

    const revision = await deleteCurrentFile(root, "added.ts", expected);

    expect(revision).toEqual({ exists: false });
    await expect(stat(currentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to delete the current file after it changes", async () => {
    const root = await createProject();
    const currentPath = join(root, "added.ts");
    await writeFile(currentPath, "added", "utf8");
    const expected = await readFileContentRevision(currentPath);
    await writeFile(currentPath, "external", "utf8");

    await expect(deleteCurrentFile(root, "added.ts", expected)).rejects.toBeInstanceOf(
      CurrentFileRevisionConflictError,
    );

    expect(await readFile(currentPath, "utf8")).toBe("external");
  });

  test("creates parent directories when restoring a missing file", async () => {
    const root = await createProject();
    const currentPath = join(root, "nested", "file.ts");
    await mkdir(join(root, "nested"));
    const expected = await readFileContentRevision(currentPath);
    await rm(join(root, "nested"), { force: true, recursive: true });

    await writeCurrentFile(root, "nested/file.ts", Buffer.from("baseline"), expected);

    expect(await readFile(currentPath, "utf8")).toBe("baseline");
  });
});
