import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-current-provider-test-"));
  temporaryDirectories.push(root);
  return root;
}

interface FakeUri {
  readonly fsPath: string;
  readonly path: string;
  readonly query: string;
  readonly scheme: string;
  toString(): string;
}

class FakeDisposable {
  dispose(): void {}
}

const firedUris: FakeUri[] = [];

class FakeEventEmitter {
  readonly event = (): FakeDisposable => new FakeDisposable();
  fire(uri: FakeUri): void {
    firedUris.push(uri);
  }
}

mock.module("vscode", () => ({
  EventEmitter: FakeEventEmitter,
  Uri: {
    from: ({ path, query, scheme }: { path: string; query: string; scheme: string }): FakeUri => ({
      fsPath: path,
      path,
      query,
      scheme,
      toString: () => `${scheme}:${path}?${query}`,
    }),
  },
}));

describe("CurrentContentProvider", () => {
  test("creates a URI with inlinediff-current scheme", async () => {
    const { CurrentContentProvider, currentContentScheme } = await import(
      "../../src/editors/current-content-provider.ts"
    );
    const provider = new CurrentContentProvider(async () => true);
    const rootUri: FakeUri = {
      fsPath: "/project/root",
      path: "/project/root",
      query: "",
      scheme: "file",
      toString: () => "file:/project/root",
    };

    const uri = provider.createCurrentUri(rootUri as never, "src/index.ts");

    expect(uri.scheme).toBe(currentContentScheme);
    expect(uri.scheme).toBe("inlinediff-current");
    expect(uri.path).toBe("/src/index.ts");
    expect(uri.query).toContain(encodeURIComponent("/project/root"));
  });

  test("reads file content from disk", async () => {
    const { CurrentContentProvider } = await import(
      "../../src/editors/current-content-provider.ts"
    );
    const root = await createDirectory();
    await writeFile(join(root, "file.ts"), "export const x = 1;\n", "utf8");

    const provider = new CurrentContentProvider(async () => true);
    const uri: FakeUri = {
      fsPath: "/file.ts",
      path: "/file.ts",
      query: `root=${encodeURIComponent(root)}`,
      scheme: "inlinediff-current",
      toString: () => `inlinediff-current:/file.ts?root=${encodeURIComponent(root)}`,
    };

    const content = await provider.provideTextDocumentContent(uri as never);

    expect(content).toBe("export const x = 1;\n");
  });

  test("returns empty string for a missing file", async () => {
    const { CurrentContentProvider } = await import(
      "../../src/editors/current-content-provider.ts"
    );
    const root = await createDirectory();

    const provider = new CurrentContentProvider(async () => true);
    const uri: FakeUri = {
      fsPath: "/nonexistent.ts",
      path: "/nonexistent.ts",
      query: `root=${encodeURIComponent(root)}`,
      scheme: "inlinediff-current",
      toString: () => `inlinediff-current:/nonexistent.ts?root=${encodeURIComponent(root)}`,
    };

    const content = await provider.provideTextDocumentContent(uri as never);

    expect(content).toBe("");
  });

  test("returns empty string for a root that is not a trusted project", async () => {
    const { CurrentContentProvider } = await import(
      "../../src/editors/current-content-provider.ts"
    );
    const root = await createDirectory();
    await writeFile(join(root, "secret.ts"), "secret", "utf8");

    const provider = new CurrentContentProvider(async () => false);
    const uri: FakeUri = {
      fsPath: "/secret.ts",
      path: "/secret.ts",
      query: `root=${encodeURIComponent(root)}`,
      scheme: "inlinediff-current",
      toString: () => `inlinediff-current:/secret.ts?root=${encodeURIComponent(root)}`,
    };

    expect(await provider.provideTextDocumentContent(uri as never)).toBe("");
  });

  test("returns empty string for a path that resolves through a symlink", async () => {
    const { CurrentContentProvider } = await import(
      "../../src/editors/current-content-provider.ts"
    );
    const root = await createDirectory();
    const outside = await mkdtemp(join(tmpdir(), "inlinediff-current-outside-test-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.ts"), "outside-secret", "utf8");
    await symlink(outside, join(root, "linked"), "junction");

    const provider = new CurrentContentProvider(async () => true);
    const uri: FakeUri = {
      fsPath: "/linked/secret.ts",
      path: "/linked/secret.ts",
      query: `root=${encodeURIComponent(root)}`,
      scheme: "inlinediff-current",
      toString: () => `inlinediff-current:/linked/secret.ts?root=${encodeURIComponent(root)}`,
    };

    const content = await provider.provideTextDocumentContent(uri as never);

    // The provider must not leak content reached through a symlink outside the project.
    expect(content).toBe("");
  });

  test("throws when URI has no root query parameter", async () => {
    const { CurrentContentProvider } = await import(
      "../../src/editors/current-content-provider.ts"
    );
    const provider = new CurrentContentProvider(async () => true);
    const uri: FakeUri = {
      fsPath: "/file.ts",
      path: "/file.ts",
      query: "",
      scheme: "inlinediff-current",
      toString: () => "inlinediff-current:/file.ts",
    };

    await expect(provider.provideTextDocumentContent(uri as never)).rejects.toThrow(
      "Current URI does not contain a project root.",
    );
  });

  test("fires onDidChange event when refresh is called", async () => {
    firedUris.length = 0;
    const { CurrentContentProvider } = await import(
      "../../src/editors/current-content-provider.ts"
    );
    const provider = new CurrentContentProvider(async () => true);
    const uri: FakeUri = {
      fsPath: "/file.ts",
      path: "/file.ts",
      query: `root=${encodeURIComponent("/project")}`,
      scheme: "inlinediff-current",
      toString: () => `inlinediff-current:/file.ts?root=${encodeURIComponent("/project")}`,
    };

    provider.refresh(uri as never);

    expect(firedUris).toHaveLength(1);
    expect(firedUris[0]).toBe(uri);
  });
});
