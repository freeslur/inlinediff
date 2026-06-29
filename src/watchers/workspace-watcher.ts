import * as vscode from "vscode";
import { isStructurallyExcludedName } from "../diff-service/structural-policy.ts";
import { toErrorMessage } from "../errors/error-message.ts";
import { FileRefreshQueue, type RefreshTimerScheduler } from "./file-refresh-queue.ts";

const debounceMilliseconds = 150;
const maxWaitMilliseconds = 1_000;

export interface WorkspaceFolderChange {
  readonly added: readonly vscode.WorkspaceFolder[];
  readonly removed: readonly vscode.WorkspaceFolder[];
}

// The slice of the VS Code workspace API the watcher needs, injected so tests can drive folder
// changes and watcher lifecycles directly without depending on the global vscode module mock.
export interface WorkspaceWatchHost {
  readonly workspaceFolders: readonly vscode.WorkspaceFolder[];
  createWatcher(folder: vscode.WorkspaceFolder): vscode.FileSystemWatcher;
  onDidChangeWorkspaceFolders(handler: (change: WorkspaceFolderChange) => void): vscode.Disposable;
  reportError(message: string): void;
}

export interface WatchWorkspaceChangesDependencies {
  readonly host?: WorkspaceWatchHost;
  readonly scheduler?: RefreshTimerScheduler;
}

const defaultHost: WorkspaceWatchHost = {
  get workspaceFolders() {
    return vscode.workspace.workspaceFolders ?? [];
  },
  createWatcher: (folder) =>
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*")),
  onDidChangeWorkspaceFolders: (handler) => vscode.workspace.onDidChangeWorkspaceFolders(handler),
  reportError: (message) => void vscode.window.showErrorMessage(message),
};

export function watchWorkspaceChanges(
  onChange: (changedUris: readonly vscode.Uri[]) => Promise<void>,
  dependencies: WatchWorkspaceChangesDependencies = {},
): vscode.Disposable {
  const host = dependencies.host ?? defaultHost;
  const disposables: vscode.Disposable[] = [];
  const watchers = new Map<string, vscode.FileSystemWatcher>();
  const refreshQueue = new FileRefreshQueue<vscode.Uri>({
    debounceMilliseconds,
    keyFor: (uri) => uri.toString(),
    maxWaitMilliseconds,
    onError: (error) => host.reportError(`Inline Diff: Refresh failed. ${toErrorMessage(error)}`),
    onRefresh: (uri) => onChange([uri]),
    ...(dependencies.scheduler === undefined ? {} : { scheduler: dependencies.scheduler }),
  });

  const scheduleRefresh = (uri: vscode.Uri): void => {
    // FileSystemWatcher URIs always use POSIX "/" separators, so splitting on "/" reliably yields
    // path segments to screen against structurally excluded names (.inlinediff, .git, …).
    if (uri.path.split("/").some(isStructurallyExcludedName)) {
      return;
    }

    refreshQueue.add(uri);
  };

  const addWatcher = (folder: vscode.WorkspaceFolder): void => {
    if (watchers.has(folder.uri.toString())) {
      return;
    }

    const watcher = host.createWatcher(folder);
    watchers.set(folder.uri.toString(), watcher);
    disposables.push(
      watcher,
      watcher.onDidChange(scheduleRefresh),
      watcher.onDidCreate(scheduleRefresh),
      watcher.onDidDelete(scheduleRefresh),
    );
  };

  for (const folder of host.workspaceFolders) {
    addWatcher(folder);
  }

  disposables.push(
    host.onDidChangeWorkspaceFolders(({ added, removed }) => {
      for (const folder of removed) {
        const watcher = watchers.get(folder.uri.toString());
        watcher?.dispose();
        watchers.delete(folder.uri.toString());
      }
      for (const folder of added) {
        addWatcher(folder);
      }
      void onChange([]);
    }),
  );

  return {
    dispose: () => {
      refreshQueue.dispose();
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
}
