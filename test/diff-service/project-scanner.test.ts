import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaselineFile } from "../../src/diff-service/baseline-store.ts";
import { untrackIgnoredFiles } from "../../src/diff-service/diff-ignore.ts";
import { initializeProject } from "../../src/diff-service/project-initializer.ts";
import { scanProject } from "../../src/diff-service/project-scanner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createProject(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-scan-test-"));
  temporaryDirectories.push(root);
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(join(root, path), content);
  }
  await initializeProject(root);
  return root;
}

describe("scanProject", () => {
  test("reports only the delta: added, modified, and deleted (never unchanged) files", async () => {
    const root = await createProject({
      "clean.ts": "same",
      "deleted.ts": "deleted",
      "modified.ts": "before",
    });
    await writeFile(join(root, "modified.ts"), "after", "utf8");
    await rm(join(root, "deleted.ts"));
    await writeFile(join(root, "added.ts"), "added", "utf8");

    // clean.ts (unchanged) and the generated .diffignore (unchanged) are not reported.
    expect(await scanProject(root)).toEqual([
      { kind: "added", relativePath: "added.ts" },
      { kind: "deleted", relativePath: "deleted.ts" },
      { kind: "modified", relativePath: "modified.ts" },
    ]);
  });

  test("does not report structural exclusions or binary files", async () => {
    const root = await createProject();
    await Bun.write(join(root, ".inlinediff", "internal.txt"), "metadata");
    await Bun.write(join(root, ".git", "internal.txt"), "metadata");
    await Bun.write(join(root, "dist", "output.js"), "build output");
    await Bun.write(join(root, "node_modules", "package", "index.js"), "dependency");
    await writeFile(join(root, "binary.bin"), Buffer.from([0x00, 0xff]));

    expect(await scanProject(root)).toEqual([]);
  });

  test("reports source files inside a nested inline diff project, but not its store internals", async () => {
    const root = await createProject();
    await Bun.write(join(root, "nested", ".inlinediff", "marker"), "");
    await Bun.write(join(root, "nested", "nested.ts"), "nested");

    expect(await scanProject(root)).toEqual([{ kind: "added", relativePath: "nested/nested.ts" }]);
  });

  test("shows a tracked text file converted to binary as binary-modified", async () => {
    const root = await createProject({ "converted.ts": "text" });
    await writeFile(join(root, "converted.ts"), Buffer.from([0x00, 0xff]));

    expect(await scanProject(root)).toEqual([
      { kind: "binary-modified", relativePath: "converted.ts" },
    ]);
  });

  test("does not report oversized added or modified text files", async () => {
    const root = await createProject({ "oversized-modified.ts": "small" });
    const oversizedText = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    await writeFile(join(root, "oversized-added.ts"), oversizedText);
    await writeFile(join(root, "oversized-modified.ts"), oversizedText);

    expect(await scanProject(root)).toEqual([]);
  });

  test("reports ignored and non-UTF-8 text files", async () => {
    const root = await createProject({ ".gitignore": "ignored.txt\n" });
    await writeFile(join(root, "ignored.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));

    expect(await scanProject(root)).toContainEqual({
      kind: "added",
      relativePath: "ignored.txt",
    });
  });

  test("hides a modified tracked file once a .diffignore rule ignores it, without untracking it", async () => {
    const root = await createProject({ "secret.log": "v1\n" });
    await writeFile(join(root, "secret.log"), "v2\n", "utf8");
    // Before ignoring, the change is reported.
    expect(await scanProject(root)).toContainEqual({
      kind: "modified",
      relativePath: "secret.log",
    });

    await writeFile(join(root, ".diffignore"), "*.log\n", "utf8");
    const scan = await scanProject(root);

    // Now hidden from the scan, but still present in the baseline (the index is left untouched).
    expect(scan).not.toContainEqual({ kind: "modified", relativePath: "secret.log" });
    expect(await readBaselineFile(root, "secret.log")).toEqual(Buffer.from("v1\n"));
    // The .diffignore edit itself is reported.
    expect(scan).toContainEqual({ kind: "modified", relativePath: ".diffignore" });
  });

  test("untrackIgnoredFiles drops newly-ignored tracked files from the baseline, keeping the working file", async () => {
    const root = await createProject({ "secret.log": "v1\n", "keep.ts": "keep\n" });
    await writeFile(join(root, ".diffignore"), "*.log\n", "utf8");

    await untrackIgnoredFiles(root);

    // Removed from the baseline, but the working file is left in place.
    expect(await readBaselineFile(root, "secret.log")).toBeUndefined();
    expect(await readFile(join(root, "secret.log"), "utf8")).toBe("v1\n");
    // Non-ignored files are untouched.
    expect(await readBaselineFile(root, "keep.ts")).toEqual(Buffer.from("keep\n"));
  });

  test("does not report files reached through a directory symlink", async () => {
    const root = await createProject();
    const outside = await mkdtemp(join(tmpdir(), "inlinediff-scan-outside-test-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "outside.ts"), "outside", "utf8");
    await symlink(outside, join(root, "linked"), "junction");

    const scan = await scanProject(root);

    expect(scan).not.toContainEqual({ kind: "added", relativePath: "linked/outside.ts" });
  });

  test("shows a file as added after its .diffignore rule is removed", async () => {
    const root = await createProject({ ".diffignore": "*.log\n", "ignored.log": "ignored\n" });
    await writeFile(join(root, ".diffignore"), "", "utf8");

    expect(await scanProject(root)).toContainEqual({
      kind: "added",
      relativePath: "ignored.log",
    });
  });
});
