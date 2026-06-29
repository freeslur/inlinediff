import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaselineFile, writeBaselineFile } from "../../src/diff-service/baseline-store.ts";
import { readFileContentRevision } from "../../src/diff-service/file-content-revision.ts";
import { runProjectGit, withProjectGitLock } from "../../src/diff-service/git-command.ts";
import { acceptAllFiles, rejectAllFiles } from "../../src/diff-service/project-actions.ts";
import { initializeProject } from "../../src/diff-service/project-initializer.ts";
import { scanProject } from "../../src/diff-service/project-scanner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createChangedProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-project-actions-test-"));
  temporaryDirectories.push(root);
  await Bun.write(join(root, "modified.ts"), "before");
  await Bun.write(join(root, "deleted.ts"), "deleted");
  await initializeProject(root);
  await writeFile(join(root, "modified.ts"), "after", "utf8");
  await rm(join(root, "deleted.ts"));
  await writeFile(join(root, "added.ts"), "added", "utf8");
  return root;
}

describe("project actions", () => {
  test("accepts all current project changes into the Git index", async () => {
    const root = await createChangedProject();

    expect(await acceptAllFiles(root)).toEqual({
      attempted: 3,
      failed: [],
      succeeded: ["added.ts", "deleted.ts", "modified.ts"],
      total: 3,
    });
    expect(await readBaselineFile(root, "modified.ts")).toEqual(Buffer.from("after"));
    expect(await readBaselineFile(root, "added.ts")).toEqual(Buffer.from("added"));
    expect(await readBaselineFile(root, "deleted.ts")).toBeUndefined();
    expect((await scanProject(root)).filter((file) => file.kind !== "clean")).toEqual([]);
  });

  test("rejects all current project changes from the Git index", async () => {
    const root = await createChangedProject();

    expect(await rejectAllFiles(root)).toEqual({
      attempted: 3,
      failed: [],
      succeeded: ["added.ts", "deleted.ts", "modified.ts"],
      total: 3,
    });
    expect(await readFile(join(root, "modified.ts"), "utf8")).toBe("before");
    expect(await readFile(join(root, "deleted.ts"), "utf8")).toBe("deleted");
    await expect(stat(join(root, "added.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("continues accepting remaining files when one file preflight fails", async () => {
    const root = await createChangedProject();

    const summary = await acceptAllFiles(root, (file) => {
      if (file.relativePath === "deleted.ts") {
        throw new Error("Cannot accept deleted.ts");
      }
    });

    expect(summary).toEqual({
      attempted: 3,
      failed: [{ error: "Cannot accept deleted.ts", relativePath: "deleted.ts" }],
      succeeded: ["added.ts", "modified.ts"],
      total: 3,
    });
    expect(await readBaselineFile(root, "added.ts")).toEqual(Buffer.from("added"));
    expect(await readBaselineFile(root, "deleted.ts")).toEqual(Buffer.from("deleted"));
    expect(await readBaselineFile(root, "modified.ts")).toEqual(Buffer.from("after"));
  });

  test("continues rejecting remaining files when one file preflight fails", async () => {
    const root = await createChangedProject();

    const summary = await rejectAllFiles(root, (file) => {
      if (file.relativePath === "deleted.ts") {
        throw new Error("Cannot reject deleted.ts");
      }
    });

    expect(summary).toEqual({
      attempted: 3,
      failed: [{ error: "Cannot reject deleted.ts", relativePath: "deleted.ts" }],
      succeeded: ["added.ts", "modified.ts"],
      total: 3,
    });
    await expect(stat(join(root, "added.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "deleted.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "modified.ts"), "utf8")).toBe("before");
  });

  test("checks each freshly scanned file immediately before applying an action", async () => {
    const root = await createChangedProject();
    const checked: string[] = [];

    await acceptAllFiles(root, (file) => {
      checked.push(file.relativePath);
    });

    expect(checked.sort()).toEqual(["added.ts", "deleted.ts", "modified.ts"]);
  });

  test("accepts text snapshots and removes deleted files with cached Git updates", async () => {
    const root = await createChangedProject();
    const commands: string[][] = [];

    const summary = await acceptAllFiles(root, undefined, {
      runProjectGit: async (rootPath, args, options) => {
        commands.push([...args]);
        return runProjectGit(rootPath, args, options);
      },
      scanProject,
      withProjectGitLock,
      writeBaselineFile,
    });

    expect(summary).toEqual({
      attempted: 3,
      failed: [],
      succeeded: ["added.ts", "deleted.ts", "modified.ts"],
      total: 3,
    });
    expect(commands).toEqual([
      ["--literal-pathspecs", "rm", "--cached", "--force", "--ignore-unmatch", "--", "deleted.ts"],
    ]);
    expect(await readBaselineFile(root, "added.ts")).toEqual(Buffer.from("added"));
    expect(await readBaselineFile(root, "modified.ts")).toEqual(Buffer.from("after"));
    expect(await readBaselineFile(root, "deleted.ts")).toBeUndefined();
  });

  test("does not batch accept an added file that becomes binary after scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-project-actions-test-"));
    temporaryDirectories.push(root);
    await initializeProject(root);
    await writeFile(join(root, "added.ts"), "text", "utf8");

    const summary = await acceptAllFiles(root, (file) => {
      if (file.relativePath === "added.ts") {
        writeFileSync(join(root, "added.ts"), Buffer.from([0, 1, 2, 3]));
      }
    });

    expect(summary).toEqual({
      attempted: 1,
      failed: [
        {
          error: "Binary file is outside Inline Diff scope: added.ts",
          relativePath: "added.ts",
        },
      ],
      succeeded: [],
      total: 1,
    });
    expect(await readBaselineFile(root, "added.ts")).toBeUndefined();
  });

  test("does not accept a file that changes after project preflight captures its revision", async () => {
    const root = await createChangedProject();

    const summary = await acceptAllFiles(root, async (file) => {
      const revision = await readFileContentRevision(join(root, file.relativePath));
      if (file.relativePath === "modified.ts") {
        await writeFile(join(root, "modified.ts"), "outside change", "utf8");
      }
      return revision;
    });

    expect(summary.failed).toContainEqual({
      error: "Current file changed before Inline Diff could update it: modified.ts",
      relativePath: "modified.ts",
    });
    expect(summary.succeeded).not.toContain("modified.ts");
    expect(await readBaselineFile(root, "modified.ts")).toEqual(Buffer.from("before"));
  });

  test("accepts the reviewed bytes when a file changes before Git add reads it", async () => {
    const root = await createChangedProject();
    const currentPath = join(root, "modified.ts");

    const summary = await acceptAllFiles(
      root,
      async (file) => {
        if (file.relativePath !== "modified.ts") {
          return undefined;
        }
        return readFileContentRevision(currentPath);
      },
      {
        runProjectGit,
        scanProject,
        withProjectGitLock,
        writeBaselineFile: async (rootPath, relativePath, content) => {
          if (relativePath === "modified.ts") {
            await writeFile(currentPath, "external", "utf8");
          }
          await writeBaselineFile(rootPath, relativePath, content);
        },
      },
    );

    expect(summary.failed).toEqual([]);
    expect(summary.succeeded).toContain("modified.ts");
    expect(await readBaselineFile(root, "modified.ts")).toEqual(Buffer.from("after"));
    expect(await readFile(currentPath, "utf8")).toBe("external");
  });

  test("does not reject a file that changes after project preflight captures its revision", async () => {
    const root = await createChangedProject();

    const summary = await rejectAllFiles(root, async (file) => {
      const revision = await readFileContentRevision(join(root, file.relativePath));
      if (file.relativePath === "modified.ts") {
        await writeFile(join(root, "modified.ts"), "outside change", "utf8");
      }
      return revision;
    });

    expect(summary.failed).toContainEqual({
      error: "Current file changed before Inline Diff could update it: modified.ts",
      relativePath: "modified.ts",
    });
    expect(summary.succeeded).not.toContain("modified.ts");
    expect(await readFile(join(root, "modified.ts"), "utf8")).toBe("outside change");
  });
});
