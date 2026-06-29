import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaselineFile } from "../../src/diff-service/baseline-store.ts";
import { CurrentFileRevisionConflictError } from "../../src/diff-service/current-file-writer.ts";
import { readFileContentRevision } from "../../src/diff-service/file-content-revision.ts";
import { acceptHunk, rejectHunk } from "../../src/diff-service/hunk-actions.ts";
import { readFileHunks } from "../../src/diff-service/hunk-engine.ts";
import { initializeProject } from "../../src/diff-service/project-initializer.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createModifiedFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
  temporaryDirectories.push(root);
  const keeps = "keep1\nkeep2\nkeep3\nkeep4\nkeep5\nkeep6\nkeep7\nkeep8\n";
  const baseline = `first\nold\n${keeps}deleted\nlast\n`;
  const current = `first\nnew\nadded\n${keeps}last\n`;
  await writeFile(join(root, "example.ts"), baseline, "utf8");
  await initializeProject(root);
  await writeFile(join(root, "example.ts"), current, "utf8");
  return root;
}

describe("hunk actions", () => {
  test("accepts only the selected current hunk into the Git index", async () => {
    const root = await createModifiedFile();
    const [hunk] = await readFileHunks(root, "example.ts");
    if (hunk === undefined) {
      throw new Error("Expected a hunk.");
    }

    await acceptHunk(root, "example.ts", hunk.id);

    expect(await readBaselineFile(root, "example.ts")).toEqual(
      Buffer.from(
        "first\nnew\nadded\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\nkeep6\nkeep7\nkeep8\ndeleted\nlast\n",
      ),
    );
    expect(await readFile(join(root, "example.ts"), "utf8")).toBe(
      "first\nnew\nadded\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\nkeep6\nkeep7\nkeep8\nlast\n",
    );
  });

  test("accepts one zero-context change without accepting a nearby change", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
    temporaryDirectories.push(root);
    const filePath = join(root, "example.ts");
    await writeFile(filePath, "first\nold-a\nbetween\nold-b\nlast\n", "utf8");
    await initializeProject(root);
    await writeFile(filePath, "first\nnew-a\nbetween\nnew-b\nlast\n", "utf8");

    const hunks = await readFileHunks(root, "example.ts");
    expect(hunks).toHaveLength(2);

    const firstHunk = hunks[0];
    if (firstHunk === undefined) {
      throw new Error("Expected the first hunk.");
    }
    await acceptHunk(root, "example.ts", firstHunk.id);

    expect(await readBaselineFile(root, "example.ts")).toEqual(
      Buffer.from("first\nnew-a\nbetween\nold-b\nlast\n"),
    );
  });

  test("accepts consecutive hunks using CodeLens IDs created before the first accept", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
    temporaryDirectories.push(root);
    const filePath = join(root, "example.ts");
    await writeFile(filePath, "first\nold-a\nbetween\nold-b\nlast\n", "utf8");
    await initializeProject(root);
    await writeFile(filePath, "first\nnew-a\nbetween\nnew-b\nlast\n", "utf8");
    const [firstHunk, secondHunk] = await readFileHunks(root, "example.ts");
    if (firstHunk === undefined || secondHunk === undefined) {
      throw new Error("Expected two hunks.");
    }

    await acceptHunk(root, "example.ts", firstHunk.id);
    await acceptHunk(root, "example.ts", secondHunk.id);

    expect(await readBaselineFile(root, "example.ts")).toEqual(
      Buffer.from("first\nnew-a\nbetween\nnew-b\nlast\n"),
    );
  });

  test("exposes a deleted file hunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
    temporaryDirectories.push(root);
    const filePath = join(root, "example.ts");
    await writeFile(filePath, "first\nsecond\n", "utf8");
    await initializeProject(root);
    await unlink(filePath);

    const [hunk] = await readFileHunks(root, "example.ts");
    if (hunk === undefined) {
      throw new Error("Expected a deleted file hunk.");
    }

    expect(hunk).toMatchObject({
      currentLineCount: 0,
      currentStartLine: 0,
      originalLineCount: 2,
      originalStartLine: 0,
    });
  });

  test("restores a deleted file hunk with the original raw bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
    temporaryDirectories.push(root);
    const filePath = join(root, "example.txt");
    const content = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("first\nsecond\n", "utf16le"),
    ]);
    await writeFile(filePath, content);
    await initializeProject(root);
    await unlink(filePath);

    const [hunk] = await readFileHunks(root, "example.txt");
    if (hunk === undefined) {
      throw new Error("Expected a deleted file hunk.");
    }
    await rejectHunk(root, "example.txt", hunk.id);

    expect(await readFile(filePath)).toEqual(content);
  });

  test("rejects a current hunk directly to disk while preserving raw bytes", async () => {
    const root = await createModifiedFile();
    const [, hunk] = await readFileHunks(root, "example.ts");
    if (hunk === undefined) {
      throw new Error("Expected a hunk.");
    }

    await rejectHunk(root, "example.ts", hunk.id);

    expect(await readFile(join(root, "example.ts"), "utf8")).toBe(
      "first\nnew\nadded\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\nkeep6\nkeep7\nkeep8\ndeleted\nlast\n",
    );
  });

  test("does not reject after the current file changes beyond the expected revision", async () => {
    const root = await createModifiedFile();
    const [hunk] = await readFileHunks(root, "example.ts");
    if (hunk === undefined) {
      throw new Error("Expected a hunk.");
    }
    const currentPath = join(root, "example.ts");
    const expected = await readFileContentRevision(currentPath);
    await writeFile(currentPath, "external\n", "utf8");

    await expect(rejectHunk(root, "example.ts", hunk.id, expected)).rejects.toBeInstanceOf(
      CurrentFileRevisionConflictError,
    );

    expect(await readFile(currentPath, "utf8")).toBe("external\n");
  });

  test("rejects an added hunk to an empty disk file", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
    temporaryDirectories.push(root);
    const filePath = join(root, "added.ts");
    await initializeProject(root);
    await writeFile(filePath, "added\n", "utf8");
    const [hunk] = await readFileHunks(root, "added.ts");
    if (hunk === undefined) {
      throw new Error("Expected an added hunk.");
    }

    await rejectHunk(root, "added.ts", hunk.id);

    expect(await readFile(filePath)).toEqual(Buffer.alloc(0));
  });

  test("accepts an added hunk into the Git index", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
    temporaryDirectories.push(root);
    const filePath = join(root, "added.ts");
    await initializeProject(root);
    await writeFile(filePath, "added\n", "utf8");
    const [hunk] = await readFileHunks(root, "added.ts");
    if (hunk === undefined) {
      throw new Error("Expected an added hunk.");
    }

    await acceptHunk(root, "added.ts", hunk.id);

    expect(await readBaselineFile(root, "added.ts")).toEqual(Buffer.from("added\n"));
  });

  test("accepts a deleted file hunk into the Git index", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
    temporaryDirectories.push(root);
    const filePath = join(root, "example.ts");
    await writeFile(filePath, "first\nsecond\n", "utf8");
    await initializeProject(root);
    await unlink(filePath);

    const [hunk] = await readFileHunks(root, "example.ts");
    if (hunk === undefined) {
      throw new Error("Expected a deleted file hunk.");
    }

    await acceptHunk(root, "example.ts", hunk.id);

    expect(await readBaselineFile(root, "example.ts")).toBeUndefined();
  });

  test("refuses a stale hunk after the current file changes", async () => {
    const root = await createModifiedFile();
    const [hunk] = await readFileHunks(root, "example.ts");
    if (hunk === undefined) {
      throw new Error("Expected a hunk.");
    }
    await writeFile(join(root, "example.ts"), "different\n", "utf8");

    await expect(acceptHunk(root, "example.ts", hunk.id)).rejects.toThrow("Stale diff hunk");
  });

  test("applies a partial UTF-16 hunk without re-encoding the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
    temporaryDirectories.push(root);
    const encodeUtf16 = (text: string): Buffer =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const keeps = "keep1\nkeep2\nkeep3\nkeep4\nkeep5\nkeep6\nkeep7\nkeep8\n";
    await writeFile(join(root, "example.txt"), encodeUtf16(`first\nold\n${keeps}deleted\nlast\n`));
    await initializeProject(root);
    await writeFile(join(root, "example.txt"), encodeUtf16(`first\nnew\nadded\n${keeps}last\n`));
    const [hunk] = await readFileHunks(root, "example.txt");
    if (hunk === undefined) {
      throw new Error("Expected a hunk.");
    }

    await acceptHunk(root, "example.txt", hunk.id);

    expect(await readBaselineFile(root, "example.txt")).toEqual(
      encodeUtf16(`first\nnew\nadded\n${keeps}deleted\nlast\n`),
    );
  });

  test("does not expose or accept hunks after a tracked text file becomes binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-hunk-actions-test-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "example.ts"), "text\n", "utf8");
    await initializeProject(root);
    await writeFile(join(root, "example.ts"), Buffer.from([0x00, 0x01, 0x02, 0xff]));

    expect(await readFileHunks(root, "example.ts")).toEqual([]);
    await expect(acceptHunk(root, "example.ts", "missing")).rejects.toThrow("Stale diff hunk");
    await expect(rejectHunk(root, "example.ts", "missing")).rejects.toThrow("Stale diff hunk");
  });
});
