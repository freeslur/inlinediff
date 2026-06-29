import * as vscode from "vscode";
import {
  type DiffHunk,
  readFileHunks as readFileHunksDefault,
} from "../diff-service/hunk-engine.ts";
import {
  type ChangedFileEntry,
  canOpenChangedFileDiff,
  createChangedFileEntries,
} from "./changed-files-model.ts";
import type { ChangedFilesStore, ProjectSnapshot } from "./changed-files-store.ts";
import { groupChangedFilesByProject } from "./changed-files-tree-model.ts";
import { KeptHunkStore } from "./kept-hunk-store.ts";

export interface WorkspaceChangedFile extends ChangedFileEntry {
  rootUri: vscode.Uri;
}

export interface WorkspaceHunkItem {
  currentLineCount: number;
  currentStartLine: number;
  file: WorkspaceChangedFile;
  hunkId: string;
  label: string;
  nodeType: "hunk";
  relativePath: string;
  rootUri: vscode.Uri;
}

export interface LoadingTreeItem {
  label: "Loading...";
  nodeType: "loading";
}

export interface ProjectTreeItem {
  children: WorkspaceChangedFile[];
  label: string;
  nodeType: "project";
  rootUri: vscode.Uri;
}

export type ChangedFilesTreeItem =
  | ProjectTreeItem
  | WorkspaceChangedFile
  | WorkspaceHunkItem
  | LoadingTreeItem;

interface ChangedFilesProviderDependencies {
  store: ChangedFilesStore;
  keptHunkStore?: KeptHunkStore;
  readHunks?: (rootPath: string, relativePath: string) => Promise<DiffHunk[]>;
}

export class ChangedFilesProvider implements vscode.TreeDataProvider<ChangedFilesTreeItem> {
  readonly #onDidChangeTreeData = new vscode.EventEmitter<ChangedFilesTreeItem | undefined>();

  readonly onDidChangeTreeData = this.#onDidChangeTreeData.event;
  #projects: ChangedFilesTreeItem[] = [];
  readonly #keptHunkStore: KeptHunkStore;
  readonly #readHunks: NonNullable<ChangedFilesProviderDependencies["readHunks"]>;
  readonly #store: ChangedFilesStore;
  readonly #unsubscribeStore: () => void;

  constructor(dependencies: ChangedFilesProviderDependencies) {
    this.#keptHunkStore = dependencies.keptHunkStore ?? new KeptHunkStore();
    this.#readHunks = dependencies.readHunks ?? readFileHunksDefault;
    this.#store = dependencies.store;
    this.#projects = createProjectTreeItemsFromSnapshots(this.#store.snapshot());
    this.#unsubscribeStore = this.#store.onDidChange(() => {
      this.#projects = createProjectTreeItemsFromSnapshots(this.#store.snapshot());
      this.#onDidChangeTreeData.fire(undefined);
    });
  }

  dispose(): void {
    this.#unsubscribeStore();
    this.#onDidChangeTreeData.dispose();
  }

  getTreeItem(item: ChangedFilesTreeItem): vscode.TreeItem {
    if (isLoadingTreeItem(item)) {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
      treeItem.contextValue = "inlinediff.loading";
      treeItem.iconPath = new vscode.ThemeIcon("sync~spin");
      return treeItem;
    }

    if (isProjectTreeItem(item)) {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.Expanded);
      treeItem.contextValue = "inlinediff.project";
      treeItem.description = `${item.children.length}`;
      treeItem.iconPath = new vscode.ThemeIcon("root-folder");
      treeItem.tooltip = item.rootUri.fsPath;
      return treeItem;
    }

    if (isWorkspaceHunkItem(item)) {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
      treeItem.checkboxState = {
        state: this.#keptHunkStore.isKept(item.rootUri.fsPath, item.relativePath, item.hunkId)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked,
        tooltip: "Keep this inline change for review",
      };
      treeItem.contextValue = "inlinediff.hunk";
      treeItem.command = {
        arguments: [item.file, item.currentStartLine],
        command: "inlinediff.openDiff",
        title: "Open Inline Diff",
      };
      treeItem.description = `+${item.currentStartLine + 1},${item.currentLineCount}`;
      treeItem.iconPath = new vscode.ThemeIcon("diff");
      treeItem.tooltip = `${item.relativePath} ${treeItem.description}`;
      return treeItem;
    }

    const file = item;
    const treeItem = new vscode.TreeItem(
      file.relativePath,
      canOpenChangedFileDiff(file)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    if (canOpenChangedFileDiff(file)) {
      treeItem.command = {
        arguments: [file],
        command: "inlinediff.openDiff",
        title: "Open Inline Diff",
      };
    }
    treeItem.contextValue = `inlinediff.${file.kind}`;
    treeItem.description = file.description;
    treeItem.iconPath = new vscode.ThemeIcon(iconFor(file.kind));
    treeItem.tooltip = `${file.description} ${file.relativePath}`;
    return treeItem;
  }

  getChildren(
    item?: ChangedFilesTreeItem,
  ): ChangedFilesTreeItem[] | Promise<ChangedFilesTreeItem[]> {
    if (item === undefined) {
      return this.#projects;
    }
    if (isProjectTreeItem(item)) {
      return item.children;
    }
    if (isWorkspaceChangedFile(item) && canOpenChangedFileDiff(item)) {
      return this.#readHunks(item.rootUri.fsPath, item.relativePath).then((hunks) => {
        this.#keptHunkStore.retainHunks(
          item.rootUri.fsPath,
          item.relativePath,
          new Set(hunks.map((hunk) => hunk.id)),
        );
        return hunks.map((hunk) => createWorkspaceHunkItem(item, hunk));
      });
    }
    return [];
  }

  updateHunkCheckboxStates(
    items: readonly [ChangedFilesTreeItem, vscode.TreeItemCheckboxState][],
  ): void {
    let changed = false;
    for (const [item, state] of items) {
      if (!isWorkspaceHunkItem(item)) {
        continue;
      }
      this.#keptHunkStore.setKept(
        item.rootUri.fsPath,
        item.relativePath,
        item.hunkId,
        state === vscode.TreeItemCheckboxState.Checked,
      );
      changed = true;
    }
    if (changed) {
      this.#onDidChangeTreeData.fire(undefined);
    }
  }

  getKeptHunkIds(rootPath: string, relativePath: string): ReadonlySet<string> {
    return this.#keptHunkStore.keptIdsFor(rootPath, relativePath);
  }

  refreshTree(): void {
    this.#onDidChangeTreeData.fire(undefined);
  }
}

function createProjectTreeItemFromFiles(project: {
  readonly files: readonly ChangedFileEntry[];
  readonly label: string;
  readonly rootPath: string;
}): ProjectTreeItem {
  return {
    children: project.files.map((file) => ({
      ...file,
      rootUri: vscode.Uri.file(project.rootPath),
    })),
    label: project.label,
    nodeType: "project",
    rootUri: vscode.Uri.file(project.rootPath),
  };
}

function createWorkspaceHunkItem(file: WorkspaceChangedFile, hunk: DiffHunk): WorkspaceHunkItem {
  return {
    currentLineCount: hunk.currentLineCount,
    currentStartLine: hunk.currentStartLine,
    file,
    hunkId: hunk.id,
    label: formatHunkLabel(hunk),
    nodeType: "hunk",
    relativePath: file.relativePath,
    rootUri: file.rootUri,
  };
}

function formatHunkLabel(hunk: DiffHunk): string {
  const start = hunk.currentStartLine + 1;
  const end = hunk.currentLineCount <= 1 ? start : start + hunk.currentLineCount - 1;
  return end === start ? `Inline Change ${start}` : `Inline Change ${start}-${end}`;
}

function createProjectTreeItemsFromSnapshots(
  snapshots: readonly ProjectSnapshot[],
): ChangedFilesTreeItem[] {
  if (snapshots.some((snapshot) => snapshot.scanState === "foreground-scanning")) {
    return [{ label: "Loading...", nodeType: "loading" }];
  }

  const successfulScans = snapshots.map((snapshot) => ({
    files: createChangedFileEntries(snapshot.files),
    rootPath: snapshot.rootPath,
  }));
  return groupChangedFilesByProject(successfulScans).map(createProjectTreeItemFromFiles);
}

function iconFor(kind: ChangedFileEntry["kind"]): string {
  switch (kind) {
    case "added":
      return "diff-added";
    case "binary-modified":
      return "warning";
    case "deleted":
      return "diff-removed";
    case "modified":
      return "diff-modified";
  }
}

function isProjectTreeItem(item: ChangedFilesTreeItem): item is ProjectTreeItem {
  return "nodeType" in item && item.nodeType === "project";
}

function isLoadingTreeItem(item: ChangedFilesTreeItem): item is LoadingTreeItem {
  return "nodeType" in item && item.nodeType === "loading";
}

function isWorkspaceChangedFile(item: ChangedFilesTreeItem): item is WorkspaceChangedFile {
  return !("nodeType" in item);
}

function isWorkspaceHunkItem(item: ChangedFilesTreeItem): item is WorkspaceHunkItem {
  return "nodeType" in item && item.nodeType === "hunk";
}
