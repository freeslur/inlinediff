import { describe, expect, mock, test } from "bun:test";
import type { ChangedFilesTreeItem } from "../../src/views/changed-files-provider.ts";

interface FakeUri {
  fsPath: string;
  path: string;
  query: string;
  scheme: string;
  toString(): string;
}

const fileUri = (path: string): FakeUri => ({
  fsPath: path,
  path,
  query: "",
  scheme: "file",
  toString: () => `file:${path}`,
});

class FakeDisposable {
  constructor(readonly dispose: () => void = () => {}) {}
}

class FakeEventEmitter {
  readonly #listeners = new Set<() => void>();

  readonly event = (listener: () => void): FakeDisposable => {
    this.#listeners.add(listener);
    return new FakeDisposable(() => {
      this.#listeners.delete(listener);
    });
  };

  fire(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

class FakeThemeIcon {
  constructor(readonly id: string) {}
}

class FakeTreeItem {
  checkboxState: unknown;
  contextValue = "";
  description = "";
  iconPath: FakeThemeIcon | undefined;
  tooltip = "";

  constructor(
    readonly label: string,
    readonly collapsibleState: number,
  ) {}
}

mock.module("vscode", () => ({
  EventEmitter: FakeEventEmitter,
  ThemeIcon: FakeThemeIcon,
  TreeItem: FakeTreeItem,
  TreeItemCollapsibleState: {
    Collapsed: 2,
    Expanded: 1,
    None: 0,
  },
  TreeItemCheckboxState: {
    Checked: 1,
    Unchecked: 0,
  },
  Uri: {
    file: fileUri,
  },
  workspace: {
    workspaceFolders: [],
  },
}));

describe("ChangedFilesProvider", () => {
  test("stops reacting to store changes after dispose", async () => {
    const { ChangedFilesProvider } = await import("../../src/views/changed-files-provider.ts");
    const { ChangedFilesStore } = await import("../../src/views/changed-files-store.ts");
    const store = new ChangedFilesStore();
    const provider = new ChangedFilesProvider({ store });
    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });

    store.replaceProject("C:/workspace/project", [{ kind: "modified", relativePath: "a.ts" }]);
    expect(fired).toBe(1);

    provider.dispose();
    store.replaceProject("C:/workspace/project", [{ kind: "modified", relativePath: "b.ts" }]);

    expect(fired).toBe(1);
  });

  test("shows binary-modified files as binary entries without opening a diff", async () => {
    const { ChangedFilesProvider } = await import("../../src/views/changed-files-provider.ts");
    const { ChangedFilesStore } = await import("../../src/views/changed-files-store.ts");
    const rootPath = "C:/workspace/project";
    const store = new ChangedFilesStore();
    store.replaceProject(rootPath, [{ kind: "binary-modified", relativePath: "converted.ts" }]);
    const provider = new ChangedFilesProvider({ store });

    const [project] = await projectNodes(provider);
    const [file] = project?.children ?? [];
    if (file === undefined) {
      throw new Error("Expected a binary file entry");
    }
    expect(file).toMatchObject({
      description: "Binary",
      kind: "binary-modified",
      relativePath: "converted.ts",
    });
  });

  test("shows changed file inline changes as checkbox children that can be kept for review", async () => {
    const { ChangedFilesProvider } = await import("../../src/views/changed-files-provider.ts");
    const { ChangedFilesStore } = await import("../../src/views/changed-files-store.ts");
    const rootPath = "C:/workspace/project";
    const store = new ChangedFilesStore();
    store.replaceProject(rootPath, [{ kind: "modified", relativePath: "src/app.ts" }]);
    const provider = new ChangedFilesProvider({
      readHunks: async () => [
        {
          currentAnchorLine: 2,
          currentLineCount: 2,
          currentStartLine: 1,
          id: "hunk-a",
          originalLineCount: 1,
          originalStartLine: 1,
          patch: Buffer.from("patch-a"),
        },
      ],
      store,
    });

    const [project] = await projectNodes(provider);
    const [file] = project?.children ?? [];
    if (file === undefined) {
      throw new Error("Expected a changed file entry.");
    }
    expect(provider.getTreeItem(file as ChangedFilesTreeItem).collapsibleState).toBe(2);

    const [hunk] = await provider.getChildren(file);
    if (hunk === undefined) {
      throw new Error("Expected a hunk child entry.");
    }
    expect(hunk).toMatchObject({
      hunkId: "hunk-a",
      label: "Inline Change 2-3",
      nodeType: "hunk",
      relativePath: "src/app.ts",
      rootUri: { fsPath: rootPath },
    });

    const unchecked = provider.getTreeItem(hunk as ChangedFilesTreeItem) as FakeTreeItem;
    expect(unchecked.contextValue).toBe("inlinediff.hunk");
    expect(unchecked.checkboxState).toMatchObject({
      state: 0,
      tooltip: "Keep this inline change for review",
    });

    provider.updateHunkCheckboxStates([[hunk as never, 1]]);

    const checked = provider.getTreeItem(hunk as ChangedFilesTreeItem) as FakeTreeItem;
    expect(checked.checkboxState).toMatchObject({
      state: 1,
      tooltip: "Keep this inline change for review",
    });
    expect(provider.getKeptHunkIds(rootPath, "src/app.ts")).toEqual(new Set(["hunk-a"]));
  });

  test("opens the diff at the hunk start line when a tree hunk is clicked", async () => {
    const { ChangedFilesProvider } = await import("../../src/views/changed-files-provider.ts");
    const { ChangedFilesStore } = await import("../../src/views/changed-files-store.ts");
    const rootPath = "C:/workspace/project";
    const store = new ChangedFilesStore();
    store.replaceProject(rootPath, [{ kind: "modified", relativePath: "src/app.ts" }]);
    const provider = new ChangedFilesProvider({
      readHunks: async () => [
        {
          currentAnchorLine: 2,
          currentLineCount: 2,
          currentStartLine: 1,
          id: "hunk-a",
          originalLineCount: 1,
          originalStartLine: 1,
          patch: Buffer.from("patch-a"),
        },
      ],
      store,
    });

    const [project] = await projectNodes(provider);
    const [file] = project?.children ?? [];
    if (file === undefined) {
      throw new Error("Expected a changed file entry.");
    }
    const [hunk] = await provider.getChildren(file);
    if (hunk === undefined) {
      throw new Error("Expected a hunk child entry.");
    }

    const treeItem = provider.getTreeItem(hunk as ChangedFilesTreeItem) as FakeTreeItem & {
      command?: { arguments?: unknown[]; command?: string };
    };
    expect(treeItem.command?.command).toBe("inlinediff.openDiff");
    expect(treeItem.command?.arguments?.[0]).toMatchObject({
      kind: "modified",
      relativePath: "src/app.ts",
    });
    expect(treeItem.command?.arguments?.[1]).toBe(1);
  });

  test("shares kept hunk state and removes stale hunk ids while reading children", async () => {
    const { ChangedFilesProvider } = await import("../../src/views/changed-files-provider.ts");
    const { ChangedFilesStore } = await import("../../src/views/changed-files-store.ts");
    const { KeptHunkStore } = await import("../../src/views/kept-hunk-store.ts");
    const rootPath = "C:/workspace/project";
    const keptHunkStore = new KeptHunkStore();
    keptHunkStore.setKept(rootPath, "src/app.ts", "hunk-a", true);
    keptHunkStore.setKept(rootPath, "src/app.ts", "stale-hunk", true);
    const store = new ChangedFilesStore();
    store.replaceProject(rootPath, [{ kind: "modified", relativePath: "src/app.ts" }]);
    const provider = new ChangedFilesProvider({
      keptHunkStore,
      readHunks: async () => [
        {
          currentAnchorLine: 2,
          currentLineCount: 1,
          currentStartLine: 1,
          id: "hunk-a",
          originalLineCount: 1,
          originalStartLine: 1,
          patch: Buffer.from("patch-a"),
        },
      ],
      store,
    });

    const [project] = await projectNodes(provider);
    const [file] = project?.children ?? [];
    if (file === undefined) {
      throw new Error("Expected a changed file entry.");
    }

    const [hunk] = await provider.getChildren(file);
    if (hunk === undefined) {
      throw new Error("Expected a hunk child entry.");
    }

    expect(provider.getTreeItem(hunk as ChangedFilesTreeItem).checkboxState).toMatchObject({
      state: 1,
      tooltip: "Keep this inline change for review",
    });
    expect(provider.getKeptHunkIds(rootPath, "src/app.ts")).toEqual(new Set(["hunk-a"]));
  });

  test("renders store snapshots without scanning projects", async () => {
    const { ChangedFilesProvider } = await import("../../src/views/changed-files-provider.ts");
    const { ChangedFilesStore } = await import("../../src/views/changed-files-store.ts");
    const rootPath = "C:/workspace/project";
    const store = new ChangedFilesStore();
    store.replaceProject(rootPath, [{ kind: "modified", relativePath: "from-store.ts" }]);
    const provider = new ChangedFilesProvider({ store });

    expect(await projectFilePaths(provider)).toEqual(["from-store.ts"]);
  });

  test("refreshes tree data when store changes", async () => {
    const { ChangedFilesProvider } = await import("../../src/views/changed-files-provider.ts");
    const { ChangedFilesStore } = await import("../../src/views/changed-files-store.ts");
    const rootPath = "C:/workspace/project";
    const store = new ChangedFilesStore();
    const provider = new ChangedFilesProvider({ store });
    let eventCount = 0;
    provider.onDidChangeTreeData(() => {
      eventCount += 1;
    });

    store.updateFile(rootPath, { kind: "added", relativePath: "new.ts" });

    expect(await projectFilePaths(provider)).toEqual(["new.ts"]);
    expect(eventCount).toBe(1);
  });

  test("shows a loading item while a store foreground scan is running", async () => {
    const { ChangedFilesProvider } = await import("../../src/views/changed-files-provider.ts");
    const { ChangedFilesStore } = await import("../../src/views/changed-files-store.ts");
    const rootPath = "C:/workspace/project";
    const store = new ChangedFilesStore();
    store.beginProjectScan(rootPath, "foreground");
    const provider = new ChangedFilesProvider({ store });

    const [loading] = await provider.getChildren();
    expect(loading).toMatchObject({
      label: "Loading...",
      nodeType: "loading",
    });
  });
});

interface ProjectNodeForTest {
  readonly children: ChangedFilesTreeItem[];
  readonly label: string;
}

async function projectNodes(provider: ProviderForTest): Promise<ProjectNodeForTest[]> {
  return (await provider.getChildren()).map((project) => {
    if (!("children" in Object(project)) || !("label" in Object(project))) {
      throw new Error("Expected a project node");
    }
    return project as ProjectNodeForTest;
  });
}

async function projectFilePaths(provider: ProviderForTest): Promise<string[]> {
  const [project] = await provider.getChildren();
  if (project === undefined || !("children" in Object(project))) {
    return [];
  }
  return (project as { children: Array<{ relativePath: string }> }).children.map(
    (file) => file.relativePath,
  );
}

interface ProviderForTest {
  getChildren(item?: unknown): Promise<unknown[]> | unknown[];
}
