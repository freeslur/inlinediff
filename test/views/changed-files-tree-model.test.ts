import { describe, expect, test } from "bun:test";
import type { ChangedFileEntry } from "../../src/views/changed-files-model.ts";
import { groupChangedFilesByProject } from "../../src/views/changed-files-tree-model.ts";

function file(relativePath: string): ChangedFileEntry {
  return {
    description: "M",
    kind: "modified",
    relativePath,
  };
}

describe("groupChangedFilesByProject", () => {
  test("groups and sorts files by project root", () => {
    expect(
      groupChangedFilesByProject([
        { files: [file("z.ts"), file("a.ts")], rootPath: "C:/workspace/project-b" },
        { files: [file("file.ts")], rootPath: "C:/workspace/project-a" },
      ]),
    ).toEqual([
      {
        files: [file("file.ts")],
        label: "project-a",
        rootPath: "C:/workspace/project-a",
      },
      {
        files: [file("a.ts"), file("z.ts")],
        label: "project-b",
        rootPath: "C:/workspace/project-b",
      },
    ]);
  });
});
