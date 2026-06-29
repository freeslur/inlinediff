import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaselineFile, writeBaselineFile } from "../../src/diff-service/baseline-store.ts";
import { runProjectGit } from "../../src/diff-service/git-command.ts";
import { initializeProject } from "../../src/diff-service/project-initializer.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("readBaselineFile", () => {
  test("returns undefined only when the path is not in the index", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-baseline-store-test-"));
    temporaryDirectories.push(root);
    await initializeProject(root);

    expect(await readBaselineFile(root, "missing.ts")).toBeUndefined();
  });

  test("reports a missing internal repository instead of treating it as an absent path", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-baseline-store-test-"));
    temporaryDirectories.push(root);
    await Bun.write(join(root, ".inlinediff", "marker"), "");

    await expect(readBaselineFile(root, "missing.ts")).rejects.toThrow("not a git repository");
  });

  test("refuses a baseline entry that is not at stage 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-baseline-store-test-"));
    temporaryDirectories.push(root);
    await initializeProject(root);
    const { stdout } = await runProjectGit(root, ["hash-object", "-w", "--stdin"], {
      input: Buffer.from("conflict"),
    });
    const objectId = stdout.toString("ascii").trim();
    // The internal repo never conflicts on its own; inject a non-zero stage entry to simulate a
    // corrupt index, which must not be trusted as a baseline blob.
    await runProjectGit(root, ["update-index", "--index-info"], {
      input: Buffer.from(`100644 ${objectId} 2\tconflict.ts\n`),
    });

    await expect(readBaselineFile(root, "conflict.ts")).rejects.toThrow();
  });

  test("writes captured content directly to the internal Git index", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-baseline-store-test-"));
    temporaryDirectories.push(root);
    await initializeProject(root);

    await writeBaselineFile(root, "captured.ts", Buffer.from("captured"));

    expect(await readBaselineFile(root, "captured.ts")).toEqual(Buffer.from("captured"));
  });
});
