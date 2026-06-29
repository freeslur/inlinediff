import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaselineFile } from "../src/diff-service/baseline-store.ts";
import { readFileHunks } from "../src/diff-service/hunk-engine.ts";
import { initializeProject } from "../src/diff-service/project-initializer.ts";
import { tryAcquireProjectOperationLock } from "../src/diff-service/project-operation-lock.ts";
import { trustProjectStore } from "../src/project-trust.ts";

const registeredCommands: string[] = [];
const commandCallbacks = new Map<string, (...args: never[]) => unknown>();
const executedCommands: unknown[][] = [];
const errorMessages: string[] = [];
const informationMessages: string[] = [];
const statusBarMessages: string[] = [];
const activeStatusBarMessages = new Set<string>();
const warningMessages: string[] = [];
const progressTitles: string[] = [];
const textDocuments: { isDirty: boolean; uri: FakeUri }[] = [];
const workspaceFolders: { name: string; uri: FakeUri }[] = [];
let changedFilesTreeRefreshes = 0;
let holdInformationMessage: Promise<unknown> | undefined;
let warningChoice: string | undefined;
let registeredCodeLensSelector: unknown;
let changedFilesTreeViewOptions: unknown;

class FakeDisposable {
  constructor(private readonly onDispose: () => void = () => undefined) {}

  dispose(): void {
    this.onDispose();
  }
}

class FakeEventEmitter {
  readonly #listeners: (() => void)[] = [];

  readonly event = (listener: () => void): FakeDisposable => {
    this.#listeners.push(listener);
    return new FakeDisposable();
  };

  dispose(): void {}

  fire(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
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

class FakeMemento {
  readonly #values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.#values.get(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    this.#values.set(key, value);
  }
}

const createWatcher = () => ({
  dispose(): void {},
  onDidChange: () => new FakeDisposable(),
  onDidCreate: () => new FakeDisposable(),
  onDidDelete: () => new FakeDisposable(),
});

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

mock.module("vscode", () => ({
  commands: {
    executeCommand: async (...args: unknown[]) => {
      executedCommands.push(args);
    },
    registerCommand: (command: string, callback: (...args: never[]) => unknown) => {
      registeredCommands.push(command);
      commandCallbacks.set(command, callback);
      return new FakeDisposable();
    },
  },
  CodeLens: FakeCodeLens,
  Disposable: FakeDisposable,
  EventEmitter: FakeEventEmitter,
  languages: {
    registerCodeLensProvider: (selector: unknown) => {
      registeredCodeLensSelector = selector;
      return new FakeDisposable();
    },
  },
  ProgressLocation: {
    Notification: 15,
  },
  Range: FakeRange,
  ThemeIcon: FakeThemeIcon,
  TreeItem: FakeTreeItem,
  TreeItemCheckboxState: {
    Checked: 1,
    Unchecked: 0,
  },
  TreeItemCollapsibleState: {
    Collapsed: 2,
    Expanded: 1,
    None: 0,
  },
  Uri: {
    file: fileUri,
    from: ({ path, query, scheme }: { path: string; query: string; scheme: string }) => ({
      fsPath: path,
      path,
      query,
      scheme,
      toString: () => `${scheme}:${path}?${query}`,
    }),
    joinPath: (base: FakeUri, relativePath: string) => fileUri(join(base.fsPath, relativePath)),
  },
  window: {
    createTreeView: (viewId: string, options: { treeDataProvider?: unknown }) => {
      if (viewId === "inlinediff.changedFiles") {
        changedFilesTreeViewOptions = options;
        const provider = options.treeDataProvider as { onDidChangeTreeData?: unknown };
        if (typeof provider.onDidChangeTreeData === "function") {
          provider.onDidChangeTreeData(() => {
            changedFilesTreeRefreshes += 1;
          });
        }
      }
      return {
        dispose: () => undefined,
        onDidChangeCheckboxState: () => new FakeDisposable(),
      };
    },
    registerTreeDataProvider: (viewId: string, provider: { onDidChangeTreeData?: unknown }) => {
      if (
        viewId === "inlinediff.changedFiles" &&
        typeof provider.onDidChangeTreeData === "function"
      ) {
        provider.onDidChangeTreeData(() => {
          changedFilesTreeRefreshes += 1;
        });
      }
      return new FakeDisposable();
    },
    setStatusBarMessage: (message: string) => {
      statusBarMessages.push(message);
      activeStatusBarMessages.add(message);
      return new FakeDisposable(() => activeStatusBarMessages.delete(message));
    },
    showErrorMessage: async (message: string) => {
      errorMessages.push(message);
    },
    showInformationMessage: async (message: string) => {
      informationMessages.push(message);
      return holdInformationMessage;
    },
    showWarningMessage: async (message: string) => {
      warningMessages.push(message);
      return warningChoice;
    },
    withProgress: async (options: { title: string }, task: () => Promise<unknown>) => {
      progressTitles.push(options.title);
      return task();
    },
  },
  workspace: {
    createFileSystemWatcher: createWatcher,
    getConfiguration: () => ({ inspect: () => ({}), update: async () => {} }),
    getWorkspaceFolder: (uri: FakeUri) =>
      workspaceFolders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath)),
    onDidCloseTextDocument: () => new FakeDisposable(),
    onDidSaveTextDocument: () => new FakeDisposable(),
    onDidChangeWorkspaceFolders: () => new FakeDisposable(),
    registerTextDocumentContentProvider: () => new FakeDisposable(),
    textDocuments,
    workspaceFolders,
  },
}));

describe("extension activation", () => {
  test("returns immediately after registering the Inline Diff commands", async () => {
    registeredCommands.length = 0;
    commandCallbacks.clear();
    executedCommands.length = 0;
    changedFilesTreeViewOptions = undefined;
    const { activate } = await import("../src/extension.ts");
    const context = { globalState: new FakeMemento(), subscriptions: [] };

    expect(activate(context as never)).toBeUndefined();
    expect(registeredCommands).toContain("inlinediff.initialize");
    expect(registeredCommands).not.toContain("inlinediff.recoverDiffSettings");
    expect(registeredCommands).toContain("inlinediff.refresh");
    expect(changedFilesTreeViewOptions).toMatchObject({
      manageCheckboxStateManually: true,
    });
    expect(registeredCodeLensSelector).toEqual([
      { scheme: "inlinediff-baseline" },
      { scheme: "inlinediff-current" },
    ]);
  });

  test("registers exactly the inlinediff commands declared in package.json", async () => {
    registeredCommands.length = 0;
    commandCallbacks.clear();
    const { activate } = await import("../src/extension.ts");
    activate({ globalState: new FakeMemento(), subscriptions: [] } as never);

    const extensionPackage = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as {
      contributes?: { commands?: Array<{ command?: string }> };
    };
    const declared = new Set(
      (extensionPackage.contributes?.commands ?? [])
        .map((command) => command.command)
        .filter((command): command is string => command !== undefined),
    );
    const registered = new Set(
      registeredCommands.filter((command) => command.startsWith("inlinediff.")),
    );

    // Every declared command must be registered (else the palette runs a no-op), and every
    // registered inlinediff command must be declared (else it has no title / is undiscoverable).
    expect([...declared].filter((command) => !registered.has(command))).toEqual([]);
    expect([...registered].filter((command) => !declared.has(command))).toEqual([]);
  });

  test("opens the actual project file as the modified diff document", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await mkdir(join(root, ".inlinediff"));
      await writeFile(join(root, "file.ts"), "current", "utf8");
      const callback = commandCallbacks.get("inlinediff.openDiff");
      if (callback === undefined) {
        throw new Error("Expected openDiff command callback.");
      }
      executedCommands.length = 0;

      await callback({
        kind: "modified",
        relativePath: "file.ts",
        rootUri: fileUri(root),
      } as never);

      const diffCommand = executedCommands.find(([command]) => command === "vscode.diff");
      const modifiedUri = diffCommand?.[2] as FakeUri;
      expect(modifiedUri.scheme).toBe("inlinediff-current");
      expect(modifiedUri.query).toContain(encodeURIComponent(root));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("positions the modified diff at the requested hunk line", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await mkdir(join(root, ".inlinediff"));
      await writeFile(join(root, "file.ts"), "current", "utf8");
      const callback = commandCallbacks.get("inlinediff.openDiff");
      if (callback === undefined) {
        throw new Error("Expected openDiff command callback.");
      }
      executedCommands.length = 0;

      await callback(
        {
          kind: "modified",
          relativePath: "file.ts",
          rootUri: fileUri(root),
        } as never,
        5 as never,
      );

      const diffCommand = executedCommands.find(([command]) => command === "vscode.diff");
      const options = diffCommand?.[4] as { selection?: { startLine: number } } | undefined;
      expect(options?.selection?.startLine).toBe(5);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("opens added files against a refreshable baseline document", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await mkdir(join(root, ".inlinediff"));
      await writeFile(join(root, "added.ts"), "current", "utf8");
      const callback = commandCallbacks.get("inlinediff.openDiff");
      if (callback === undefined) {
        throw new Error("Expected openDiff command callback.");
      }
      executedCommands.length = 0;

      await callback({
        kind: "added",
        relativePath: "added.ts",
        rootUri: fileUri(root),
      } as never);

      const diffCommand = executedCommands.find(([command]) => command === "vscode.diff");
      const originalUri = diffCommand?.[1] as FakeUri;
      expect(originalUri.scheme).toBe("inlinediff-baseline");
      expect(originalUri.path).toBe("/added.ts");
      expect(originalUri.query).not.toContain("empty=true");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reopens deleted file diffs after rejecting a deleted hunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await writeFile(join(root, "deleted.ts"), "baseline", "utf8");
      await initializeProject(root);
      await rm(join(root, "deleted.ts"), { force: true });
      const openDiffCallback = commandCallbacks.get("inlinediff.openDiff");
      const rejectHunkCallback = commandCallbacks.get("inlinediff.rejectHunk");
      if (openDiffCallback === undefined || rejectHunkCallback === undefined) {
        throw new Error("Expected registered extension callbacks.");
      }
      executedCommands.length = 0;

      await openDiffCallback({
        kind: "deleted",
        relativePath: "deleted.ts",
        rootUri: fileUri(root),
      } as never);
      const deletedDiffCommand = executedCommands.find(([command]) => command === "vscode.diff");
      const emptyModifiedUri = deletedDiffCommand?.[2] as FakeUri;
      textDocuments.push({ isDirty: false, uri: emptyModifiedUri });
      const [deletedHunk] = await readFileHunks(root, "deleted.ts");
      if (deletedHunk === undefined) {
        throw new Error("Expected deleted file hunk.");
      }
      executedCommands.length = 0;

      await rejectHunkCallback({
        hunkId: deletedHunk.id,
        relativePath: "deleted.ts",
        rootPath: root,
      } as never);

      const refreshedDiffCommand = executedCommands.find(([command]) => command === "vscode.diff");
      const modifiedUri = refreshedDiffCommand?.[2] as FakeUri;
      expect(modifiedUri.scheme).toBe("inlinediff-current");
      expect(modifiedUri.query).toContain(encodeURIComponent(root));
    } finally {
      textDocuments.length = 0;
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses file actions while the current project file has unsaved changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await mkdir(join(root, ".inlinediff"));
      const currentPath = join(root, "file.ts");
      await writeFile(currentPath, "current", "utf8");
      const acceptCallback = commandCallbacks.get("inlinediff.acceptFile");
      if (acceptCallback === undefined) {
        throw new Error("Expected registered extension callbacks.");
      }
      const file = {
        kind: "modified",
        relativePath: "file.ts",
        rootUri: fileUri(root),
      };
      textDocuments.push({ isDirty: true, uri: fileUri(currentPath) });
      errorMessages.length = 0;
      const refreshCount = changedFilesTreeRefreshes;

      await acceptCallback(file as never);

      expect(errorMessages.some((message) => message.includes("Unsaved changes"))).toBe(true);
      expect(changedFilesTreeRefreshes).toBe(refreshCount);
    } finally {
      textDocuments.length = 0;
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses Reject while the current project file has unsaved changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await mkdir(join(root, ".inlinediff"));
      const currentPath = join(root, "file.ts");
      await writeFile(currentPath, "current", "utf8");
      const rejectCallback = commandCallbacks.get("inlinediff.rejectFile");
      if (rejectCallback === undefined) {
        throw new Error("Expected rejectFile command callback.");
      }
      const file = {
        kind: "modified",
        relativePath: "file.ts",
        rootUri: fileUri(root),
      };
      textDocuments.push({ isDirty: true, uri: fileUri(currentPath) });
      errorMessages.length = 0;

      await rejectCallback(file as never);

      expect(errorMessages.some((message) => message.includes("Unsaved changes"))).toBe(true);
    } finally {
      textDocuments.length = 0;
      await rm(root, { force: true, recursive: true });
    }
  });

  test("context-only commands explain missing arguments instead of throwing", async () => {
    const contextOnlyCommands = [
      "inlinediff.openDiff",
      "inlinediff.acceptFile",
      "inlinediff.rejectFile",
      "inlinediff.acceptAll",
      "inlinediff.rejectAll",
      "inlinediff.acceptHunk",
      "inlinediff.rejectHunk",
      "inlinediff.toggleKeepHunk",
      "inlinediff.acceptUnkeptHunks",
    ];
    informationMessages.length = 0;

    for (const command of contextOnlyCommands) {
      const callback = commandCallbacks.get(command);
      if (callback === undefined) {
        throw new Error(`Expected ${command} command callback.`);
      }

      await callback(undefined as never);
    }

    expect(informationMessages).toEqual(
      contextOnlyCommands.map(
        () => "Inline Diff: Use this command from the Changed Files view or Inline Diff editor.",
      ),
    );
  });

  test("reports when another process holds the project operation lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    let lease: Awaited<ReturnType<typeof tryAcquireProjectOperationLock>> | undefined;
    try {
      await writeFile(join(root, "file.ts"), "baseline", "utf8");
      await initializeProject(root);
      await writeFile(join(root, "file.ts"), "current", "utf8");
      lease = await tryAcquireProjectOperationLock(root);
      const acceptCallback = commandCallbacks.get("inlinediff.acceptFile");
      if (acceptCallback === undefined) {
        throw new Error("Expected acceptFile command callback.");
      }
      if (lease === undefined) {
        throw new Error("Expected project operation lock lease.");
      }
      statusBarMessages.length = 0;

      await acceptCallback({
        kind: "modified",
        relativePath: "file.ts",
        rootUri: fileUri(root),
      } as never);

      expect(statusBarMessages).toContain(
        "Inline Diff: another operation is already running for this project.",
      );
    } finally {
      await lease?.release();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("accepts unchecked hunks while keeping checked hunks for review", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await writeFile(join(root, "file.ts"), "one\nkeep\nthree\naccept\n", "utf8");
      await initializeProject(root);
      await writeFile(join(root, "file.ts"), "one\nKEEP\nthree\nACCEPT\n", "utf8");
      const acceptUnkeptCallback = commandCallbacks.get("inlinediff.acceptUnkeptHunks");
      if (acceptUnkeptCallback === undefined) {
        throw new Error("Expected acceptUnkeptHunks command callback.");
      }
      const provider = (
        changedFilesTreeViewOptions as {
          treeDataProvider?: {
            getChildren(item?: unknown): Promise<unknown[]> | unknown[];
            updateHunkCheckboxStates(items: readonly [unknown, number][]): void;
          };
        }
      ).treeDataProvider;
      if (provider === undefined) {
        throw new Error("Expected changed files tree provider.");
      }
      const file = {
        kind: "modified",
        relativePath: "file.ts",
        rootUri: fileUri(root),
      };
      const [keptHunk] = await provider.getChildren(file);
      if (keptHunk === undefined) {
        throw new Error("Expected a hunk child.");
      }
      provider.updateHunkCheckboxStates([[keptHunk, 1]]);

      await acceptUnkeptCallback(file as never);

      expect(await readBaselineFile(root, "file.ts")).toEqual(
        Buffer.from("one\nkeep\nthree\nACCEPT\n"),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("toggles kept hunk state from an Inline Diff editor command", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await writeFile(join(root, "file.ts"), "one\nkeep\n", "utf8");
      await initializeProject(root);
      await writeFile(join(root, "file.ts"), "one\nKEEP\n", "utf8");
      const toggleCallback = commandCallbacks.get("inlinediff.toggleKeepHunk");
      if (toggleCallback === undefined) {
        throw new Error("Expected toggleKeepHunk command callback.");
      }
      const provider = (
        changedFilesTreeViewOptions as {
          treeDataProvider?: {
            getChildren(item?: unknown): Promise<unknown[]> | unknown[];
            getKeptHunkIds(rootPath: string, relativePath: string): ReadonlySet<string>;
          };
        }
      ).treeDataProvider;
      if (provider === undefined) {
        throw new Error("Expected changed files provider.");
      }
      const file = {
        kind: "modified",
        relativePath: "file.ts",
        rootUri: fileUri(root),
      };
      const [hunk] = await provider.getChildren(file);
      if (
        typeof hunk !== "object" ||
        hunk === null ||
        !("hunkId" in hunk) ||
        typeof hunk.hunkId !== "string"
      ) {
        throw new Error("Expected a hunk child.");
      }

      await toggleCallback({
        hunkId: hunk.hunkId,
        relativePath: "file.ts",
        rootPath: root,
      } as never);

      expect(provider.getKeptHunkIds(root, "file.ts")).toEqual(new Set([hunk.hunkId]));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("releases Accept All status and busy state before the summary message resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await writeFile(join(root, "deleted.ts"), "baseline", "utf8");
      await initializeProject(root);
      await rm(join(root, "deleted.ts"), { force: true });
      let releaseInformation: (() => void) | undefined;
      holdInformationMessage = new Promise<void>((resolve) => {
        releaseInformation = resolve;
      });
      const acceptAllCallback = commandCallbacks.get("inlinediff.acceptAll");
      const acceptFileCallback = commandCallbacks.get("inlinediff.acceptFile");
      if (acceptAllCallback === undefined || acceptFileCallback === undefined) {
        throw new Error("Expected registered extension callbacks.");
      }
      const project = {
        children: [{ kind: "deleted", relativePath: "deleted.ts", rootUri: fileUri(root) }],
        label: "project",
        nodeType: "project",
        rootUri: fileUri(root),
      };
      informationMessages.length = 0;
      statusBarMessages.length = 0;
      progressTitles.length = 0;
      activeStatusBarMessages.clear();

      const acceptAll = acceptAllCallback(project as never);
      await waitFor(() => informationMessages.includes("Inline Diff accepted 1 changed files."));

      expect(progressTitles).toContain("Inline Diff: Accepting all changes");
      expect(activeStatusBarMessages.has("Inline Diff: Processing Accept All...")).toBe(false);
      await writeFile(join(root, "new.ts"), "new", "utf8");
      await acceptFileCallback({
        kind: "added",
        relativePath: "new.ts",
        rootUri: fileUri(root),
      } as never);

      expect(statusBarMessages).not.toContain("Inline Diff: Accept File is already running.");
      releaseInformation?.();
      await acceptAll;
    } finally {
      holdInformationMessage = undefined;
      informationMessages.length = 0;
      statusBarMessages.length = 0;
      progressTitles.length = 0;
      activeStatusBarMessages.clear();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("routes trusted watcher changes to incremental file refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "inlinediff-extension-activation-test-"));
    try {
      await writeFile(join(root, "file.ts"), "baseline", "utf8");
      const metadata = await initializeProject(root);
      const storage = new FakeMemento();
      await trustProjectStore(storage as never, root, metadata);
      workspaceFolders.push({ name: "project", uri: fileUri(root) });
      const handledEvents: Array<{ relativePath: string; rootPath: string }> = [];
      const markedEvents: Array<{ relativePath: string; rootPath: string }> = [];
      const { processChangedFiles } = await import("../src/extension.ts");

      await processChangedFiles(
        [fileUri(join(root, "file.ts"))] as never,
        storage as never,
        {
          markChanged: (rootPath: string, relativePath: string) => {
            markedEvents.push({ relativePath, rootPath });
          },
        },
        {
          handleFileEvent: async (rootPath: string, relativePath: string) => {
            handledEvents.push({ relativePath, rootPath });
          },
        },
      );

      expect(markedEvents).toEqual([{ relativePath: "file.ts", rootPath: root }]);
      expect(handledEvents).toEqual([{ relativePath: "file.ts", rootPath: root }]);
    } finally {
      workspaceFolders.length = 0;
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for condition.");
}
