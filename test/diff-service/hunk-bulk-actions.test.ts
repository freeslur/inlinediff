import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaselineFile } from "../../src/diff-service/baseline-store.ts";
import { readFileContentRevision } from "../../src/diff-service/file-content-revision.ts";
import { runProjectGit, withProjectGitLock } from "../../src/diff-service/git-command.ts";
import { acceptUnkeptHunks } from "../../src/diff-service/hunk-bulk-actions.ts";
import { readFileHunks } from "../../src/diff-service/hunk-engine.ts";
import { initializeProject } from "../../src/diff-service/project-initializer.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("acceptUnkeptHunks", () => {
  test("accepts every hunk except the hunks kept for review", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-bulk-actions-test-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "file.ts"), "one\nkeep\nthree\naccept\n", "utf8");
    await initializeProject(root);
    await writeFile(join(root, "file.ts"), "one\nKEEP\nthree\nACCEPT\n", "utf8");
    const hunks = await readFileHunks(root, "file.ts");
    expect(hunks).toHaveLength(2);
    const keptHunk = hunks[0];
    const acceptedHunk = hunks[1];
    if (keptHunk === undefined || acceptedHunk === undefined) {
      throw new Error("Expected two hunks.");
    }

    const summary = await acceptUnkeptHunks(root, "file.ts", new Set([keptHunk.id]));

    expect(summary).toEqual({
      attempted: 1,
      failed: [],
      kept: [keptHunk.id],
      succeeded: [acceptedHunk.id],
      total: 2,
    });
    expect(await readBaselineFile(root, "file.ts")).toEqual(
      Buffer.from("one\nkeep\nthree\nACCEPT\n"),
    );
    expect(await readFile(join(root, "file.ts"), "utf8")).toBe("one\nKEEP\nthree\nACCEPT\n");
  });

  test("applies all accepted hunks with one cached patch check and apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-bulk-actions-test-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "file.ts"), "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
    await initializeProject(root);
    await writeFile(join(root, "file.ts"), "ONE\ntwo\nTHREE\nfour\nFIVE\nsix\n", "utf8");
    const hunks = await readFileHunks(root, "file.ts");
    expect(hunks).toHaveLength(3);
    const keptHunk = hunks[1];
    if (keptHunk === undefined) {
      throw new Error("Expected a kept hunk.");
    }
    const commands: string[][] = [];

    const summary = await acceptUnkeptHunks(root, "file.ts", new Set([keptHunk.id]), undefined, {
      readFileHunks,
      runProjectGit: async (rootPath, args, options) => {
        commands.push([...args]);
        return runProjectGit(rootPath, args, options);
      },
      withProjectGitLock,
    });

    expect(summary.failed).toEqual([]);
    expect(summary.succeeded).toHaveLength(2);
    expect(commands).toEqual([
      ["apply", "--cached", "--unidiff-zero", "--check", "-"],
      ["apply", "--cached", "--unidiff-zero", "-"],
    ]);
    expect(await readBaselineFile(root, "file.ts")).toEqual(
      Buffer.from("ONE\ntwo\nthree\nfour\nFIVE\nsix\n"),
    );
  });

  test("does not apply hunks when the file changes while the latest hunks are read", async () => {
    // The preflight asserts bracket the latest-hunks read: this pins the post-read assert, which
    // keeps a change landing during that read from accepting hunks computed from a stale state.
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-bulk-actions-test-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "file.ts"), "one\ntwo\nthree\n", "utf8");
    await initializeProject(root);
    await writeFile(join(root, "file.ts"), "ONE\ntwo\nTHREE\n", "utf8");
    const expected = await readFileContentRevision(join(root, "file.ts"));

    let reads = 0;
    const summary = await acceptUnkeptHunks(root, "file.ts", new Set(), () => expected, {
      readFileHunks: async (rootPath, relativePath) => {
        reads += 1;
        const hunks = await readFileHunks(rootPath, relativePath);
        if (reads === 2) {
          // Mutate after the latest-hunks read but before the post-read assert.
          await writeFile(join(rootPath, relativePath), "changed\ntwo\nTHREE\n", "utf8");
        }
        return hunks;
      },
      runProjectGit,
      withProjectGitLock,
    });

    expect(summary.succeeded).toEqual([]);
    expect(summary.failed.length).toBeGreaterThan(0);
    expect(await readBaselineFile(root, "file.ts")).toEqual(Buffer.from("one\ntwo\nthree\n"));
  });

  test("reports accepted hunks as failed when the file changes after preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-bulk-actions-test-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "file.ts"), "one\ntwo\nthree\n", "utf8");
    await initializeProject(root);
    await writeFile(join(root, "file.ts"), "ONE\ntwo\nTHREE\n", "utf8");

    const summary = await acceptUnkeptHunks(root, "file.ts", new Set(), async () => {
      const revision = await readFileContentRevision(join(root, "file.ts"));
      await writeFile(join(root, "file.ts"), "external\ntwo\nTHREE\n", "utf8");
      return revision;
    });

    expect(summary.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: "Current file changed before Inline Diff could update it: file.ts",
        }),
      ]),
    );
  });
});
