import { describe, expect, mock, test } from "bun:test";
import type { DiffHunk } from "../../src/diff-service/hunk-engine.ts";

class FakeDisposable {
  dispose(): void {}
}

class FakeEventEmitter {
  readonly event = (): FakeDisposable => new FakeDisposable();

  fire(): void {}
}

class FakeRange {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}

class FakeCodeLens {
  constructor(
    readonly range: FakeRange,
    readonly command: unknown,
  ) {}
}

interface FakeUri {
  readonly fsPath: string;
  readonly path: string;
  readonly query: string;
  readonly scheme: string;
  toString(): string;
}

interface FakeDocument {
  readonly isDirty: boolean;
  readonly lineCount: number;
  readonly uri: FakeUri;
  lineAt(line: number): { readonly range: { readonly end: { readonly character: number } } };
}

const fileUri = (path: string): FakeUri => ({
  fsPath: path,
  path,
  query: "",
  scheme: "file",
  toString: () => `file:${path}`,
});

function createDocument(uri: FakeUri, options: { readonly dirty?: boolean } = {}): FakeDocument {
  return {
    isDirty: options.dirty ?? false,
    lineAt: () => ({ range: { end: { character: 12 } } }),
    lineCount: 3,
    uri,
  };
}

function createHunk(id = "hunk-1"): DiffHunk {
  return {
    currentAnchorLine: 1,
    currentLineCount: 1,
    currentStartLine: 1,
    id,
    originalLineCount: 1,
    originalStartLine: 1,
    patch: Buffer.from("patch"),
  };
}

mock.module("vscode", () => ({
  CodeLens: FakeCodeLens,
  EventEmitter: FakeEventEmitter,
  Range: FakeRange,
}));

describe("HunkCodeLensProvider direct file contexts", () => {
  test("does not read hunks for a normal explorer-opened file", async () => {
    const { HunkCodeLensProvider } = await import("../../src/views/hunk-codelens-provider.ts");
    let readHunks = false;
    const provider = new HunkCodeLensProvider(undefined, {
      isChanging: () => false,
      readHunks: async () => {
        readHunks = true;
        return [createHunk()];
      },
      registry: {
        resolveDocument: () => undefined,
      },
    });

    const lenses = await provider.provideCodeLenses(createDocument(fileUri("C:/project/file.ts")));

    expect(lenses).toEqual([]);
    expect(readHunks).toBe(false);
  });

  test("does not read hunks while a registered Inline Diff file is changing", async () => {
    const { HunkCodeLensProvider } = await import("../../src/views/hunk-codelens-provider.ts");
    let readHunks = false;
    const provider = new HunkCodeLensProvider(undefined, {
      isChanging: () => true,
      readHunks: async () => {
        readHunks = true;
        return [createHunk()];
      },
      registry: {
        resolveDocument: () => ({ relativePath: "file.ts", rootPath: "C:/project" }),
      },
    });

    const lenses = await provider.provideCodeLenses(createDocument(fileUri("C:/project/file.ts")));

    expect(lenses).toEqual([]);
    expect(readHunks).toBe(false);
  });

  test("creates accept, reject, and keep lenses for a stable registered Inline Diff file", async () => {
    const { HunkCodeLensProvider } = await import("../../src/views/hunk-codelens-provider.ts");
    const { KeptHunkStore } = await import("../../src/views/kept-hunk-store.ts");
    const provider = new HunkCodeLensProvider(undefined, {
      isChanging: () => false,
      keptHunkStore: new KeptHunkStore(),
      readHunks: async () => [createHunk("current-hunk")],
      registry: {
        resolveDocument: () => ({ relativePath: "file.ts", rootPath: "C:/project" }),
      },
    });

    const lenses = await provider.provideCodeLenses(createDocument(fileUri("C:/project/file.ts")));

    expect(lenses).toHaveLength(3);
    expect(lenses.map((lens) => lens.command)).toEqual([
      {
        arguments: [{ hunkId: "current-hunk", relativePath: "file.ts", rootPath: "C:/project" }],
        command: "inlinediff.acceptHunk",
        title: "$(check) Accept Change",
      },
      {
        arguments: [{ hunkId: "current-hunk", relativePath: "file.ts", rootPath: "C:/project" }],
        command: "inlinediff.rejectHunk",
        title: "$(discard) Reject Change",
      },
      {
        arguments: [{ hunkId: "current-hunk", relativePath: "file.ts", rootPath: "C:/project" }],
        command: "inlinediff.toggleKeepHunk",
        title: "$(bookmark) Keep for Review",
      },
    ]);
  });

  test("uses the unkeep title for kept hunks and drops stale keep state after rendering", async () => {
    const { HunkCodeLensProvider } = await import("../../src/views/hunk-codelens-provider.ts");
    const { KeptHunkStore } = await import("../../src/views/kept-hunk-store.ts");
    const keptHunkStore = new KeptHunkStore();
    keptHunkStore.setKept("C:/project", "file.ts", "current-hunk", true);
    keptHunkStore.setKept("C:/project", "file.ts", "stale-hunk", true);
    const provider = new HunkCodeLensProvider(undefined, {
      isChanging: () => false,
      keptHunkStore,
      readHunks: async () => [createHunk("current-hunk")],
      registry: {
        resolveDocument: () => ({ relativePath: "file.ts", rootPath: "C:/project" }),
      },
    });

    const lenses = await provider.provideCodeLenses(createDocument(fileUri("C:/project/file.ts")));

    expect(lenses.map((lens) => lens.command).at(-1)).toEqual({
      arguments: [{ hunkId: "current-hunk", relativePath: "file.ts", rootPath: "C:/project" }],
      command: "inlinediff.toggleKeepHunk",
      title: "$(bookmark) Unkeep (Kept for Review)",
    });
    expect(keptHunkStore.keptIdsFor("C:/project", "file.ts")).toEqual(new Set(["current-hunk"]));
  });
});
