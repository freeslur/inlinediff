import type { DiffHunk } from "../diff-service/hunk-engine.ts";

export interface HunkCodeLensEntry {
  hunkId: string;
  line: number;
}

export interface HunkCodeLensPosition {
  character: number;
  line: number;
}

export const hunkCodeLensTitles = {
  accept: "$(check) Accept Change",
  keep: "$(bookmark) Keep for Review",
  reject: "$(discard) Reject Change",
  unkeep: "$(bookmark) Unkeep (Kept for Review)",
} as const;

export function createHunkCodeLensEntries(
  hunks: readonly DiffHunk[],
  lineCount: number,
): HunkCodeLensEntry[] {
  const lastAnchorLine = Math.max(0, lineCount);
  return hunks.map((hunk) => ({
    hunkId: hunk.id,
    line: Math.min(hunk.currentAnchorLine, lastAnchorLine),
  }));
}

export function createHunkCodeLensPosition(
  entry: HunkCodeLensEntry,
  lineCount: number,
  lineEndCharacter: number,
): HunkCodeLensPosition {
  return {
    character: entry.line >= lineCount ? 0 : lineEndCharacter,
    line: entry.line,
  };
}
