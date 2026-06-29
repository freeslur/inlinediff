import { describe, expect, test } from "bun:test";
import { parseGitPatch } from "../../src/diff-service/hunk-engine.ts";

describe("parseGitPatch", () => {
  test("splits a Git patch into independently applicable hunks", () => {
    const patch = Buffer.from(
      [
        "diff --git a/example.ts b/example.ts",
        "index 1111111..2222222 100644",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -2 +2,2 @@",
        "-old",
        "+new",
        "+added",
        "@@ -4 +5,0 @@",
        "-deleted",
        "",
      ].join("\n"),
    );

    const hunks = parseGitPatch(patch);

    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      currentLineCount: 2,
      currentStartLine: 1,
      originalLineCount: 1,
      originalStartLine: 1,
    });
    expect(hunks[0]?.currentAnchorLine).toBe(3);
    expect(hunks[0]?.patch.includes(Buffer.from("+added\n"))).toBe(true);
    expect(hunks[0]?.patch.includes(Buffer.from("-deleted\n"))).toBe(false);
    expect(hunks[1]?.currentAnchorLine).toBe(5);
    expect(hunks[1]).toMatchObject({
      currentLineCount: 0,
      currentStartLine: 5,
      originalLineCount: 1,
      originalStartLine: 3,
    });
    expect(hunks[1]?.patch.includes(Buffer.from("-deleted\n"))).toBe(true);
  });

  test("returns no hunks for empty and binary Git diff output", () => {
    expect(parseGitPatch(Buffer.alloc(0))).toEqual([]);
    expect(
      parseGitPatch(
        Buffer.from(
          "diff --git a/file.bin b/file.bin\nBinary files a/file.bin and b/file.bin differ\n",
        ),
      ),
    ).toEqual([]);
  });

  test("anchors CodeLens immediately after the zero-context changed block", () => {
    const patch = Buffer.from(
      [
        "diff --git a/example.ts b/example.ts",
        "index 1111111..2222222 100644",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -2,5 +2,5 @@",
        "-old",
        "+new",
        " context1",
        " context2",
        " context3",
        " context4",
        "",
      ].join("\n"),
    );

    expect(parseGitPatch(patch)[0]?.currentAnchorLine).toBe(2);
  });

  test("anchors added-only hunks at the current change anchor", () => {
    const patch = Buffer.from(
      [
        "diff --git a/new.md b/new.md",
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        "+++ b/new.md",
        "@@ -0,0 +1,3 @@",
        "+line1",
        "+line2",
        "+line3",
        "",
      ].join("\n"),
    );

    expect(parseGitPatch(patch)[0]).toMatchObject({
      currentAnchorLine: 3,
      currentLineCount: 3,
      currentStartLine: 0,
      originalLineCount: 0,
      originalStartLine: 0,
    });
  });
});
