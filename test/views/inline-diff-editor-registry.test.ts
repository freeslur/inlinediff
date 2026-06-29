import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

interface FakeUri {
  readonly fsPath: string;
  readonly path: string;
  readonly query: string;
  readonly scheme: string;
  toString(): string;
}

const fileUri = (path: string): FakeUri => ({
  fsPath: path,
  path,
  query: "",
  scheme: "file",
  toString: () => `file:${path}`,
});

const virtualUri = (scheme: string, path: string, query: string): FakeUri => ({
  fsPath: path,
  path,
  query,
  scheme,
  toString: () => `${scheme}:${path}?${query}`,
});

mock.module("vscode", () => ({
  Uri: {
    file: fileUri,
    from: ({ path, query, scheme }: { path: string; query: string; scheme: string }) =>
      virtualUri(scheme, path, query),
  },
}));

describe("InlineDiffEditorRegistry", () => {
  test("resolves only files registered through Inline Diff", async () => {
    const { InlineDiffEditorRegistry } = await import(
      "../../src/views/inline-diff-editor-registry.ts"
    );
    const registry = new InlineDiffEditorRegistry();
    const rootPath = "C:/project";
    const modifiedUri = fileUri(join(rootPath, "src/file.ts"));

    registry.register({
      baselineUri: virtualUri("inlinediff-baseline", "/src/file.ts", "root=C%3A%2Fproject"),
      modifiedUri,
      relativePath: "src/file.ts",
      rootPath,
    });

    expect(registry.resolveDocument(modifiedUri)).toEqual({
      relativePath: "src/file.ts",
      rootPath,
    });
    expect(registry.resolveDocument(fileUri(join(rootPath, "src/other.ts")))).toBeUndefined();
  });

  test("resolves an empty modified virtual document for a deleted file", async () => {
    const { InlineDiffEditorRegistry } = await import(
      "../../src/views/inline-diff-editor-registry.ts"
    );
    const registry = new InlineDiffEditorRegistry();
    const modifiedUri = virtualUri(
      "inlinediff-baseline",
      "/deleted.ts",
      "empty=true&side=modified&root=C%3A%2Fproject",
    );

    registry.register({
      baselineUri: virtualUri("inlinediff-baseline", "/deleted.ts", "root=C%3A%2Fproject"),
      modifiedUri,
      relativePath: "deleted.ts",
      rootPath: "C:/project",
    });

    expect(registry.resolveDocument(modifiedUri)).toEqual({
      relativePath: "deleted.ts",
      rootPath: "C:/project",
    });
  });

  test("removes a context when either side of the diff closes", async () => {
    const { InlineDiffEditorRegistry } = await import(
      "../../src/views/inline-diff-editor-registry.ts"
    );
    const registry = new InlineDiffEditorRegistry();
    const baselineUri = virtualUri("inlinediff-baseline", "/src/file.ts", "root=C%3A%2Fproject");
    const modifiedUri = fileUri("C:/project/src/file.ts");

    registry.register({
      baselineUri,
      modifiedUri,
      relativePath: "src/file.ts",
      rootPath: "C:/project",
    });

    registry.unregisterDocument(baselineUri);

    expect(registry.resolveDocument(modifiedUri)).toBeUndefined();
  });
});
