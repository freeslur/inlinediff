import { describe, expect, test } from "bun:test";
import type { DiffHunk } from "../../src/diff-service/hunk-engine.ts";
import { createRejectedHunkContent } from "../../src/diff-service/hunk-reject-content.ts";

function hunk(
  originalStartLine: number,
  originalLineCount: number,
  currentStartLine: number,
  currentLineCount: number,
): DiffHunk {
  return {
    currentAnchorLine: currentStartLine + currentLineCount,
    currentLineCount,
    currentStartLine,
    id: "hunk",
    originalLineCount,
    originalStartLine,
    patch: Buffer.alloc(0),
  };
}

describe("createRejectedHunkContent", () => {
  test("replaces the exact current line range with baseline bytes", () => {
    expect(
      createRejectedHunkContent(
        hunk(1, 1, 1, 2),
        Buffer.from("first\nold\nlast\n"),
        Buffer.from("first\nnew\nadded\nlast\n"),
      ),
    ).toEqual(Buffer.from("first\nold\nlast\n"));
  });

  test("preserves UTF-16 bytes", () => {
    const encode = (text: string): Buffer =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

    expect(
      createRejectedHunkContent(
        hunk(1, 1, 1, 1),
        encode("first\nold\nlast\n"),
        encode("first\nnew\nlast\n"),
      ),
    ).toEqual(encode("first\nold\nlast\n"));
  });

  test("preserves UTF-16 bytes without a BOM", () => {
    const encode = (text: string): Buffer => Buffer.from(text, "utf16le");

    expect(
      createRejectedHunkContent(
        hunk(1, 1, 1, 1),
        encode("first\nold\nlast\n"),
        encode("first\nnew\nlast\n"),
      ),
    ).toEqual(encode("first\nold\nlast\n"));
  });
});
