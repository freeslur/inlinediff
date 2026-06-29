import { describe, expect, test } from "bun:test";
import type { DiffHunk } from "../../src/diff-service/hunk-engine.ts";
import {
  createHunkCodeLensEntries,
  createHunkCodeLensPosition,
  hunkCodeLensTitles,
} from "../../src/views/hunk-codelens-model.ts";

function hunk(
  id: string,
  currentAnchorLine: number,
  currentStartLine = currentAnchorLine,
  overrides: Partial<DiffHunk> = {},
): DiffHunk {
  return {
    currentAnchorLine,
    currentLineCount: 1,
    currentStartLine,
    id,
    originalLineCount: 1,
    originalStartLine: currentAnchorLine,
    patch: Buffer.alloc(0),
    ...overrides,
  };
}

describe("createHunkCodeLensEntries", () => {
  test("uses the line after each hunk and clamps past end-of-file anchors", () => {
    expect(createHunkCodeLensEntries([hunk("first", 2), hunk("block", 10, 3)], 5)).toEqual([
      { hunkId: "first", line: 2 },
      { hunkId: "block", line: 5 },
    ]);
  });

  test("keeps an end-of-file anchor after the last document line", () => {
    expect(createHunkCodeLensEntries([hunk("added-file", 2)], 2)).toEqual([
      { hunkId: "added-file", line: 2 },
    ]);
  });

  test("uses the current anchor for added-only hunks with a trailing newline", () => {
    expect(
      createHunkCodeLensEntries(
        [
          hunk("added-file", 3, 0, {
            currentLineCount: 3,
            originalLineCount: 0,
          }),
        ],
        4,
      ),
    ).toEqual([{ hunkId: "added-file", line: 3 }]);
  });

  test("uses the current anchor for added-only hunks with a leading newline", () => {
    expect(
      createHunkCodeLensEntries(
        [
          hunk("leading-newline", 12, 10, {
            currentLineCount: 2,
            originalLineCount: 0,
          }),
        ],
        20,
      ),
    ).toEqual([{ hunkId: "leading-newline", line: 12 }]);
  });

  test("uses the current anchor for added-only hunks at the final trailing newline", () => {
    expect(
      createHunkCodeLensEntries(
        [
          hunk("leading-final-newline", 2, 0, {
            currentLineCount: 2,
            originalLineCount: 0,
          }),
        ],
        3,
      ),
    ).toEqual([{ hunkId: "leading-final-newline", line: 2 }]);
  });

  test("supports an empty document", () => {
    expect(createHunkCodeLensEntries([hunk("empty", 0)], 0)).toEqual([
      { hunkId: "empty", line: 0 },
    ]);
  });

  test("places actions at the end of the changed line", () => {
    expect(createHunkCodeLensPosition({ hunkId: "hunk", line: 3 }, 10, 17)).toEqual({
      character: 17,
      line: 3,
    });
  });

  test("places end-of-file actions at the start of the virtual next line", () => {
    expect(createHunkCodeLensPosition({ hunkId: "hunk", line: 2 }, 2, 17)).toEqual({
      character: 0,
      line: 2,
    });
  });

  test("uses VS Code codicons for hunk actions", () => {
    expect(hunkCodeLensTitles).toEqual({
      accept: "$(check) Accept Change",
      keep: "$(bookmark) Keep for Review",
      reject: "$(discard) Reject Change",
      unkeep: "$(bookmark) Unkeep (Kept for Review)",
    });
  });
});
