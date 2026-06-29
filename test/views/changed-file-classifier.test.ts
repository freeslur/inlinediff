import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeProject } from "../../src/diff-service/project-initializer.ts";
import { maxDiffableTextFileBytes } from "../../src/diff-service/tracking-policy.ts";
import { classifyChangedFile } from "../../src/views/changed-file-classifier.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-classifier-test-"));
  temporaryDirectories.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), content, "utf8");
  }
  await initializeProject(root);
  return root;
}

describe("classifyChangedFile", () => {
  test("classifies modified and clean tracked files", async () => {
    const root = await createProject({ "file.ts": "before" });
    await writeFile(join(root, "file.ts"), "after", "utf8");

    expect(await classifyChangedFile(root, "file.ts")).toEqual({
      kind: "modified",
      relativePath: "file.ts",
    });

    await writeFile(join(root, "file.ts"), "before", "utf8");
    expect(await classifyChangedFile(root, "file.ts")).toEqual({
      kind: "clean",
      relativePath: "file.ts",
    });
  });

  test("classifies added and deleted files", async () => {
    const root = await createProject({ "deleted.ts": "gone" });
    await rm(join(root, "deleted.ts"));
    await writeFile(join(root, "added.ts"), "new", "utf8");

    expect(await classifyChangedFile(root, "deleted.ts")).toEqual({
      kind: "deleted",
      relativePath: "deleted.ts",
    });
    expect(await classifyChangedFile(root, "added.ts")).toEqual({
      kind: "added",
      relativePath: "added.ts",
    });
  });

  test("returns clean for ignored added files", async () => {
    const root = await createProject({ ".diffignore": "*.log\n" });
    await writeFile(join(root, "ignored.log"), "ignored", "utf8");

    expect(await classifyChangedFile(root, "ignored.log")).toEqual({
      kind: "clean",
      relativePath: "ignored.log",
    });
    expect(await readFile(join(root, "ignored.log"), "utf8")).toBe("ignored");
  });

  test("returns clean for a path reached through a directory symlink", async () => {
    const root = await createProject({ "real.ts": "x" });
    const outside = await mkdtemp(join(tmpdir(), "inlinediff-classifier-outside-test-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "outside.ts"), "secret", "utf8");
    await symlink(outside, join(root, "linked"), "junction");

    expect(await classifyChangedFile(root, "linked/outside.ts")).toEqual({
      kind: "clean",
      relativePath: "linked/outside.ts",
    });
  });

  test("returns clean when a tracked text file grows past the diff size limit", async () => {
    const root = await createProject({ "large.ts": "small" });
    await writeFile(join(root, "large.ts"), "a".repeat(maxDiffableTextFileBytes + 1), "utf8");

    expect(await classifyChangedFile(root, "large.ts")).toEqual({
      kind: "clean",
      relativePath: "large.ts",
    });
  });
});
