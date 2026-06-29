import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaselineFile } from "../../src/diff-service/baseline-store.ts";
import { CurrentFileRevisionConflictError } from "../../src/diff-service/current-file-writer.ts";
import { acceptFile, rejectFile } from "../../src/diff-service/file-actions.ts";
import { readFileContentRevision } from "../../src/diff-service/file-content-revision.ts";
import { initializeProject } from "../../src/diff-service/project-initializer.ts";
import { scanProject } from "../../src/diff-service/project-scanner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createProject(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-actions-test-"));
  temporaryDirectories.push(root);
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(join(root, path), content);
  }
  await initializeProject(root);
  return root;
}

describe("acceptFile", () => {
  test("accepts added, modified, and deleted files into the Git index", async () => {
    const root = await createProject({ "deleted.ts": "deleted", "modified.ts": "before" });
    await writeFile(join(root, "modified.ts"), "after", "utf8");
    await writeFile(join(root, "added.ts"), "added", "utf8");
    await rm(join(root, "deleted.ts"));

    await acceptFile(root, "modified.ts");
    await acceptFile(root, "added.ts");
    await acceptFile(root, "deleted.ts");

    expect(await readBaselineFile(root, "modified.ts")).toEqual(Buffer.from("after"));
    expect(await readBaselineFile(root, "added.ts")).toEqual(Buffer.from("added"));
    expect(await readBaselineFile(root, "deleted.ts")).toBeUndefined();
    expect((await scanProject(root)).filter((file) => file.kind !== "clean")).toEqual([]);
  });

  test("refuses to accept binary content", async () => {
    const root = await createProject();
    await writeFile(join(root, "binary.bin"), Buffer.from([0x00, 0xff]));

    await expect(acceptFile(root, "binary.bin")).rejects.toThrow("Binary file");
  });

  test("removes a binary-modified tracked file from the repository without deleting the current file", async () => {
    const root = await createProject({ "converted.ts": "text" });
    const currentPath = join(root, "converted.ts");
    const binaryContent = Buffer.from([0x00, 0xff]);
    await writeFile(currentPath, binaryContent);

    await acceptFile(root, "converted.ts");

    expect(await readBaselineFile(root, "converted.ts")).toBeUndefined();
    expect(await readFile(currentPath)).toEqual(binaryContent);
    expect(await scanProject(root)).toEqual([]);
  });

  test("accepts the latest current file directly", async () => {
    const root = await createProject({ "file.ts": "baseline" });
    const currentPath = join(root, "file.ts");
    await writeFile(currentPath, "reviewed", "utf8");
    await writeFile(currentPath, "later", "utf8");

    await acceptFile(root, "file.ts");

    expect(await readBaselineFile(root, "file.ts")).toEqual(Buffer.from("later"));
    expect(await readFile(currentPath, "utf8")).toBe("later");
  });

  test("serializes concurrent accepts without losing index updates", async () => {
    const root = await createProject(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`file-${index}.ts`, `before-${index}`]),
      ),
    );
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeFile(join(root, `file-${index}.ts`), `after-${index}`, "utf8"),
      ),
    );

    await Promise.all(
      Array.from({ length: 12 }, (_, index) => acceptFile(root, `file-${index}.ts`)),
    );

    for (let index = 0; index < 12; index += 1) {
      expect(await readBaselineFile(root, `file-${index}.ts`)).toEqual(
        Buffer.from(`after-${index}`),
      );
    }
  });
});

describe("rejectFile", () => {
  test("restores modified and deleted files from the Git index", async () => {
    const root = await createProject({ "deleted.ts": "deleted", "modified.ts": "before" });
    await writeFile(join(root, "modified.ts"), "after", "utf8");
    await rm(join(root, "deleted.ts"));

    await rejectFile(root, "modified.ts");
    await rejectFile(root, "deleted.ts");

    expect(await readFile(join(root, "modified.ts"), "utf8")).toBe("before");
    expect(await readFile(join(root, "deleted.ts"), "utf8")).toBe("deleted");
  });

  test("rejects an added file by deleting it", async () => {
    const root = await createProject();
    await writeFile(join(root, "added.ts"), "current", "utf8");

    await rejectFile(root, "added.ts");

    await expect(stat(join(root, "added.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("restores a binary-modified tracked file from the repository", async () => {
    const root = await createProject({ "converted.ts": "text" });
    const currentPath = join(root, "converted.ts");
    await writeFile(currentPath, Buffer.from([0x00, 0xff]));

    await rejectFile(root, "converted.ts");

    expect(await readFile(currentPath, "utf8")).toBe("text");
    expect(await readBaselineFile(root, "converted.ts")).toEqual(Buffer.from("text"));
    // Restored to the baseline content, so it is unchanged and no longer reported.
    expect(await scanProject(root)).toEqual([]);
  });

  test("does not reject after the current file changes beyond the expected revision", async () => {
    const root = await createProject({ "file.ts": "baseline" });
    const currentPath = join(root, "file.ts");
    await writeFile(currentPath, "reviewed", "utf8");
    const expected = await readFileContentRevision(currentPath);
    await writeFile(currentPath, "external", "utf8");

    await expect(rejectFile(root, "file.ts", expected)).rejects.toBeInstanceOf(
      CurrentFileRevisionConflictError,
    );

    expect(await readFile(currentPath, "utf8")).toBe("external");
  });

  test("rejects paths outside the project root", async () => {
    const root = await createProject();

    await expect(rejectFile(root, "../outside.ts")).rejects.toThrow("Invalid project path");
  });

  test("rejects paths inside the protected Git repo and inline diff store", async () => {
    const root = await createProject();

    await expect(rejectFile(root, ".git/config")).rejects.toThrow("Invalid project path");
    await expect(rejectFile(root, ".INLINEDIFF/repository/config")).rejects.toThrow(
      "Invalid project path",
    );
  });

  test("does not follow a directory symlink outside the project", async () => {
    const root = await createProject();
    const outside = await mkdtemp(join(tmpdir(), "inlinediff-actions-outside-test-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "outside.ts"), "keep", "utf8");
    await symlink(outside, join(root, "linked"), "junction");

    await expect(rejectFile(root, "linked/outside.ts")).rejects.toThrow("Invalid project path");
    expect(await readFile(join(outside, "outside.ts"), "utf8")).toBe("keep");
  });
});
