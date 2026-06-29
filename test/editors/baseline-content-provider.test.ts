import { describe, expect, mock, test } from "bun:test";

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

class FakeEventEmitter {
  readonly event = (): FakeDisposable => new FakeDisposable();
  fire(): void {}
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

describe("BaselineContentProvider", () => {
  test("returns empty string for a root that is not a trusted project", async () => {
    const { BaselineContentProvider } = await import(
      "../../src/editors/baseline-content-provider.ts"
    );
    const provider = new BaselineContentProvider(async () => false);
    const uri: FakeUri = {
      fsPath: "/secret.ts",
      path: "/secret.ts",
      query: `root=${encodeURIComponent("C:/Users/victim")}`,
      scheme: "inlinediff-baseline",
      toString: () => "inlinediff-baseline:/secret.ts",
    };

    expect(await provider.provideTextDocumentContent(uri as never)).toBe("");
  });

  test("serves an empty-side URI without consulting trust", async () => {
    const { BaselineContentProvider } = await import(
      "../../src/editors/baseline-content-provider.ts"
    );
    const provider = new BaselineContentProvider(async () => {
      throw new Error("trust check should not run for an empty-side URI");
    });
    const uri: FakeUri = {
      fsPath: "/file.ts",
      path: "/file.ts",
      query: "empty=true&side=original&root=anything",
      scheme: "inlinediff-baseline",
      toString: () => "inlinediff-baseline:/file.ts",
    };

    expect(await provider.provideTextDocumentContent(uri as never)).toBe("");
  });
});
