import { createHash } from "node:crypto";
import { isMissingPathError } from "../errors/fs-errors.ts";
import { readBaselineFile } from "./baseline-store.ts";
import { runProjectGit } from "./git-command.ts";
import { resolveSafeProjectPath } from "./project-path.ts";
import { isBinaryContent } from "./text-content.ts";
import { isTrackableTextFile } from "./tracking-policy.ts";

export interface DiffHunk {
  currentAnchorLine: number;
  currentLineCount: number;
  currentStartLine: number;
  id: string;
  originalLineCount: number;
  originalStartLine: number;
  patch: Buffer;
}

interface PatchLine {
  end: number;
  start: number;
}

export async function readFileHunks(rootPath: string, relativePath: string): Promise<DiffHunk[]> {
  const currentPath = await resolveSafeProjectPath(rootPath, relativePath);
  return readHunks(rootPath, relativePath, currentPath);
}

async function readHunks(
  rootPath: string,
  relativePath: string,
  currentPath: string,
): Promise<DiffHunk[]> {
  let currentExists = true;
  try {
    if (!(await isTrackableTextFile(currentPath))) {
      return [];
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    currentExists = false;
    const baseline = await readBaselineFile(rootPath, relativePath);
    if (baseline === undefined || isBinaryContent(baseline)) {
      return [];
    }
  }
  const baselineExists = (await readBaselineFile(rootPath, relativePath)) !== undefined;
  const diffArguments =
    currentExists && !baselineExists ? ["diff", "--no-index"] : ["--literal-pathspecs", "diff"];
  const arguments_ = [
    ...diffArguments,
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--unified=0",
    "--no-renames",
    "--",
    ...(currentExists && !baselineExists ? ["/dev/null", relativePath] : [relativePath]),
  ];
  const options = currentExists && !baselineExists ? { allowedExitCodes: [1] } : undefined;
  const { stdout } = await runProjectGit(rootPath, arguments_, options);
  return parseGitPatch(stdout);
}

export function parseGitPatch(patch: Buffer): DiffHunk[] {
  const lines = splitLines(patch);
  const hunkLines = lines.filter((line) => startsWith(patch, line.start, "@@ "));
  const firstHunk = hunkLines[0];
  if (firstHunk === undefined) {
    return [];
  }

  const header = patch.subarray(0, firstHunk.start);
  return hunkLines.map((line, index) => {
    const nextLine = hunkLines[index + 1];
    const hunkPatch = Buffer.concat([
      header,
      patch.subarray(line.start, nextLine?.start ?? patch.length),
    ]);
    const headerText = patch.subarray(line.start, line.end).toString("ascii");
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(headerText);
    if (match === null) {
      throw new Error(`Invalid Git hunk header: ${headerText.trim()}`);
    }
    const originalStart = Number(match[1]);
    const originalCount = match[2] === undefined ? 1 : Number(match[2]);
    const currentStart = Number(match[3]);
    const currentCount = match[4] === undefined ? 1 : Number(match[4]);
    const currentStartLine = zeroBasedStartLine(currentStart, currentCount);
    const hunkBody = patch.subarray(line.end, nextLine?.start ?? patch.length);
    return {
      currentAnchorLine: findCurrentChangeAnchor(hunkBody, currentStartLine),
      currentLineCount: currentCount,
      currentStartLine,
      id: createStableHunkId(currentStartLine, currentCount, hunkBody),
      originalLineCount: originalCount,
      originalStartLine: zeroBasedStartLine(originalStart, originalCount),
      patch: hunkPatch,
    };
  });
}

// Hunk ids must stay stable when Accept updates only the baseline/index and leaves
// the current file bytes untouched. Current range plus body content keeps nearby
// unrelated hunks addressable after another hunk is accepted.
function createStableHunkId(
  currentStartLine: number,
  currentLineCount: number,
  body: Buffer,
): string {
  return createHash("sha256")
    .update(`${currentStartLine}:${currentLineCount}\0`)
    .update(body)
    .digest("hex")
    .slice(0, 16);
}

function zeroBasedStartLine(start: number, count: number): number {
  return Math.max(0, count === 0 ? start : start - 1);
}

// CodeLens actions sit after the current-side change when possible. For deleted
// hunks there is no added line, so the unchanged current line becomes the anchor.
function findCurrentChangeAnchor(hunkBody: Buffer, currentStartLine: number): number {
  let currentLine = currentStartLine;
  let anchor = currentStartLine;
  for (const line of splitLines(hunkBody)) {
    const prefix = hunkBody[line.start];
    if (prefix === 0x2b) {
      currentLine += 1;
      anchor = currentLine;
    } else if (prefix === 0x2d) {
      anchor = currentLine;
    } else if (prefix === 0x20) {
      currentLine += 1;
    }
  }
  return anchor;
}

function splitLines(content: Buffer): PatchLine[] {
  const lines: PatchLine[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0a) {
      lines.push({ end: index + 1, start });
      start = index + 1;
    }
  }
  if (start < content.length) {
    lines.push({ end: content.length, start });
  }
  return lines;
}

function startsWith(content: Buffer, offset: number, prefix: string): boolean {
  return content.subarray(offset, offset + prefix.length).equals(Buffer.from(prefix, "ascii"));
}
