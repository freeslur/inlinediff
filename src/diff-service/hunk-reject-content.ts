import type { DiffHunk } from "./hunk-engine.ts";

export function createRejectedHunkContent(
  hunk: DiffHunk,
  baseline: Buffer,
  current: Buffer,
): Buffer {
  // Reject is a byte splice, not a text rewrite: offsets are computed with the
  // file's newline width so BOM-marked UTF-16/UTF-32 content keeps its encoding.
  const baselineOffsets = lineStartOffsets(baseline);
  const currentOffsets = lineStartOffsets(current);
  const currentStart = offsetAtLine(currentOffsets, hunk.currentStartLine, current.length);
  const currentEnd = offsetAtLine(
    currentOffsets,
    hunk.currentStartLine + hunk.currentLineCount,
    current.length,
  );
  const originalStart = offsetAtLine(baselineOffsets, hunk.originalStartLine, baseline.length);
  const originalEnd = offsetAtLine(
    baselineOffsets,
    hunk.originalStartLine + hunk.originalLineCount,
    baseline.length,
  );

  return Buffer.concat([
    current.subarray(0, currentStart),
    baseline.subarray(originalStart, originalEnd),
    current.subarray(currentEnd),
  ]);
}

function lineStartOffsets(content: Buffer): number[] {
  const newline = newlineBytes(content);
  const offsets = [0];
  for (let index = 0; index <= content.length - newline.length; index += newline.length) {
    if (content.subarray(index, index + newline.length).equals(newline)) {
      offsets.push(index + newline.length);
    }
  }
  return offsets;
}

function newlineBytes(content: Buffer): Buffer {
  if (content.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0x00, 0x00]))) {
    return Buffer.from([0x0a, 0x00, 0x00, 0x00]);
  }
  if (content.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0xfe, 0xff]))) {
    return Buffer.from([0x00, 0x00, 0x00, 0x0a]);
  }
  if (content.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return Buffer.from([0x0a, 0x00]);
  }
  if (content.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return Buffer.from([0x00, 0x0a]);
  }
  return Buffer.from([0x0a]);
}

function offsetAtLine(offsets: readonly number[], line: number, contentLength: number): number {
  return offsets[line] ?? contentLength;
}
