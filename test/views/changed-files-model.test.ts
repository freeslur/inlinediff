import { describe, expect, test } from "bun:test";
import {
  canOpenChangedFileDiff,
  createChangedFileEntries,
} from "../../src/views/changed-files-model.ts";

describe("createChangedFileEntries", () => {
  test("filters clean files and sorts changed files by path", () => {
    expect(
      createChangedFileEntries([
        { kind: "modified", relativePath: "z.ts" },
        { kind: "clean", relativePath: "clean.ts" },
        { kind: "binary-modified", relativePath: "binary.ts" },
        { kind: "added", relativePath: "a.ts" },
      ]),
    ).toEqual([
      { description: "A", kind: "added", relativePath: "a.ts" },
      { description: "Binary", kind: "binary-modified", relativePath: "binary.ts" },
      { description: "M", kind: "modified", relativePath: "z.ts" },
    ]);
  });

  test("does not open diffs for binary-modified files", () => {
    expect(
      canOpenChangedFileDiff({
        description: "Binary",
        kind: "binary-modified",
        relativePath: "binary.ts",
      }),
    ).toBe(false);
    expect(
      canOpenChangedFileDiff({
        description: "M",
        kind: "modified",
        relativePath: "modified.ts",
      }),
    ).toBe(true);
  });
});
