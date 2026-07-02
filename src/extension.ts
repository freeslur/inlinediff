import { relative } from "node:path";
import * as vscode from "vscode";
import { CurrentFileActionGuard } from "./diff-service/current-file-action-guard.ts";
import { untrackIgnoredFiles } from "./diff-service/diff-ignore.ts";
import {
  applyDiffSettings,
  type DiffSettingsAdapter,
  hasDiffSettingConflict,
  restoreDiffSettings,
} from "./diff-service/diff-settings.ts";
import { acceptFile, rejectFile } from "./diff-service/file-actions.ts";
import type { FileContentRevision } from "./diff-service/file-content-revision.ts";
import { FileStabilityTracker } from "./diff-service/file-stability-tracker.ts";
import { collectGarbage, withProjectGitLock } from "./diff-service/git-command.ts";
import { acceptHunk, rejectHunk } from "./diff-service/hunk-actions.ts";
import { acceptUnkeptHunks, type HunkActionSummary } from "./diff-service/hunk-bulk-actions.ts";
import { readFileHunks } from "./diff-service/hunk-engine.ts";
import { acceptAllFiles, rejectAllFiles } from "./diff-service/project-actions.ts";
import { discoverWorkspaceStores, type WorkspaceStores } from "./diff-service/project-discovery.ts";
import {
  findInitializableProjectRoots,
  initializeProject,
} from "./diff-service/project-initializer.ts";
import { ProjectOperationCoordinator } from "./diff-service/project-operation-coordinator.ts";
import { tryAcquireProjectOperationLock } from "./diff-service/project-operation-lock.ts";
import { ProjectOperationRunner } from "./diff-service/project-operation-runner.ts";
import { type PendingHunk, ProjectOperationState } from "./diff-service/project-operation-state.ts";
import { normalizeRelativePath } from "./diff-service/project-path.ts";
import { scanProject } from "./diff-service/project-scanner.ts";
import {
  BaselineContentProvider,
  baselineContentScheme,
} from "./editors/baseline-content-provider.ts";
import {
  CurrentContentProvider,
  currentContentScheme,
} from "./editors/current-content-provider.ts";
import { toErrorMessage } from "./errors/error-message.ts";
import { showProjectActionSummaryMessage } from "./project-action-messages.ts";
import {
  filterTrustedProjectRoots,
  filterUntrustedStoreRoots,
  isProjectStoreTrusted,
  type TrustedStoreStorage,
  trustProjectStore,
} from "./project-trust.ts";
import { resolveUntrustedProjectStore } from "./untrusted-store-resolution.ts";
import { classifyChangedFile } from "./views/changed-file-classifier.ts";
import {
  ChangedFilesProvider,
  type ProjectTreeItem,
  type WorkspaceChangedFile,
} from "./views/changed-files-provider.ts";
import { ChangedFilesRefreshController } from "./views/changed-files-refresh-controller.ts";
import { ChangedFilesStore } from "./views/changed-files-store.ts";
import { HunkCodeLensProvider, type HunkCommandArguments } from "./views/hunk-codelens-provider.ts";
import { InlineDiffEditorRegistry } from "./views/inline-diff-editor-registry.ts";
import { KeptHunkStore } from "./views/kept-hunk-store.ts";
import { processWorkspaceChanges } from "./watchers/workspace-change-set.ts";
import { watchWorkspaceChanges } from "./watchers/workspace-watcher.ts";

export function activate(context: vscode.ExtensionContext): void {
  const ignoredUntrustedStoreKeys = new Set<string>();
  const changedFilesStore = new ChangedFilesStore();
  const keptHunkStore = new KeptHunkStore();
  const refreshController = new ChangedFilesRefreshController(changedFilesStore, {
    classifyFile: classifyChangedFile,
    scanProject,
  });
  const changedFilesProvider = new ChangedFilesProvider({
    keptHunkStore,
    store: changedFilesStore,
  });
  const changedFilesTreeView = vscode.window.createTreeView("inlinediff.changedFiles", {
    manageCheckboxStateManually: true,
    treeDataProvider: changedFilesProvider,
  });
  const isProjectRootTrusted = (rootPath: string) =>
    isProjectStoreTrusted(context.globalState, rootPath);
  const baselineContentProvider = new BaselineContentProvider(isProjectRootTrusted);
  const currentContentProvider = new CurrentContentProvider(isProjectRootTrusted);
  const projectOperationState = new ProjectOperationState();
  const fileStabilityTracker = new FileStabilityTracker();
  const inlineDiffEditorRegistry = new InlineDiffEditorRegistry();
  const currentFileActionGuard = new CurrentFileActionGuard({
    isChanging: (rootPath, relativePath) => fileStabilityTracker.isChanging(rootPath, relativePath),
    isDirty: (rootPath, relativePath) => isCurrentFileDirty(rootPath, relativePath),
  });
  const hunkCodeLensProvider = new HunkCodeLensProvider(projectOperationState, {
    isChanging: (rootPath, relativePath) => fileStabilityTracker.isChanging(rootPath, relativePath),
    keptHunkStore,
    readHunks: readFileHunks,
    registry: inlineDiffEditorRegistry,
  });
  const disposeKeptHunkListener = keptHunkStore.onDidChange(() => {
    changedFilesProvider.refreshTree();
    hunkCodeLensProvider.refresh();
  });
  const disposeStabilityStatusListener = fileStabilityTracker.onDidChangeStatus(() => {
    hunkCodeLensProvider.refresh();
  });
  const projectOperationCoordinator = new ProjectOperationCoordinator(projectOperationState, () =>
    hunkCodeLensProvider.refresh(),
  );
  const projectOperationRunner = new ProjectOperationRunner(projectOperationCoordinator);

  context.subscriptions.push(
    changedFilesProvider,
    changedFilesTreeView,
    changedFilesTreeView.onDidChangeCheckboxState((event) =>
      changedFilesProvider.updateHunkCheckboxStates(event.items),
    ),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: baselineContentScheme }, { scheme: currentContentScheme }],
      hunkCodeLensProvider,
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      baselineContentScheme,
      baselineContentProvider,
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      currentContentScheme,
      currentContentProvider,
    ),
    new vscode.Disposable(disposeKeptHunkListener),
    new vscode.Disposable(disposeStabilityStatusListener),
    vscode.workspace.onDidCloseTextDocument((document) =>
      runCommand("Close Inline Diff", async () => {
        inlineDiffEditorRegistry.unregisterDocument(document.uri);
        hunkCodeLensProvider.refresh();
      }),
    ),
    vscode.commands.registerCommand("inlinediff.refresh", () =>
      runCommand("Refresh", () =>
        refreshWorkspaceState(refreshController, context.globalState, ignoredUntrustedStoreKeys),
      ),
    ),
    vscode.commands.registerCommand("inlinediff.initialize", () =>
      runCommand("Initialize Project", async () => {
        const folder = await selectInitializableWorkspaceFolder();
        if (folder === undefined) {
          return;
        }
        const adapter = createDiffSettingsAdapter(folder);
        let applySettings = true;
        if (hasDiffSettingConflict(adapter)) {
          const choice = await vscode.window.showWarningMessage(
            "Inline Diff needs diff editor settings to display inline diffs.",
            {
              modal: true,
              detail:
                'The settings will be written to workspace settings and affect all diff editors in VS Code, not just Inline Diff\'s. Your previous settings will be backed up and can be restored with "Inline Diff: Restore Diff Settings".',
            },
            "Accept",
            "Initialize only",
          );
          if (choice === undefined) {
            return;
          }
          applySettings = choice === "Accept";
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Initializing Inline Diff: ${folder.name}`,
          },
          async () => {
            const storeId = await initializeProject(folder.uri.fsPath);
            await trustProjectStore(context.globalState, folder.uri.fsPath, storeId);
            if (applySettings) {
              await applyDiffSettings(folder.uri.fsPath, adapter);
            }
          },
        );
        await refreshWorkspaceState(
          refreshController,
          context.globalState,
          ignoredUntrustedStoreKeys,
        );
        await vscode.window.showInformationMessage(`Inline Diff initialized: ${folder.name}`);
      }),
    ),
    vscode.commands.registerCommand("inlinediff.openDiff", (file: unknown, line?: unknown) => {
      if (!isWorkspaceChangedFile(file)) {
        return explainContextOnlyCommand();
      }
      return runCommand("Open Diff", async () => {
        const folder = vscode.workspace.getWorkspaceFolder(file.rootUri);
        if (folder !== undefined) {
          const adapter = createDiffSettingsAdapter(folder);
          if (hasDiffSettingConflict(adapter)) {
            const choice = await vscode.window.showWarningMessage(
              "Diff editor settings don't match Inline Diff's requirements.",
              {
                modal: true,
                detail:
                  'Applying the required settings will affect all diff editors in VS Code, not just Inline Diff\'s. Your previous settings will be backed up and can be restored with "Inline Diff: Restore Diff Settings".',
              },
              "Change settings",
            );
            if (choice !== "Change settings") {
              return;
            }
            await applyDiffSettings(file.rootUri.fsPath, adapter);
          }
        }
        await openDiff(
          file,
          baselineContentProvider,
          currentContentProvider,
          inlineDiffEditorRegistry,
          typeof line === "number" ? line : undefined,
        );
      });
    }),
    vscode.commands.registerCommand("inlinediff.restoreDiffSettings", () =>
      runCommand("Restore Diff Settings", async () => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const stores = await discoverWorkspaceStores(folders.map((f) => f.uri.fsPath));
        const trustedRoots = new Set(
          await filterTrustedProjectRoots(stores.projectRoots, context.globalState),
        );
        const candidates = folders.filter((f) => trustedRoots.has(f.uri.fsPath));
        if (candidates.length === 0) {
          await vscode.window.showInformationMessage(
            "Inline Diff: No initialized project found in this workspace.",
          );
          return;
        }
        let folder: vscode.WorkspaceFolder | undefined;
        if (candidates.length === 1) {
          folder = candidates[0];
        } else {
          const selected = await vscode.window.showQuickPick(
            candidates.map((f) => ({ description: f.uri.fsPath, folder: f, label: f.name })),
            { placeHolder: "Select a project to restore diff settings for" },
          );
          folder = selected?.folder;
        }
        if (folder === undefined) {
          return;
        }
        const restored = await restoreDiffSettings(
          folder.uri.fsPath,
          createDiffSettingsAdapter(folder),
        );
        await vscode.window.showInformationMessage(
          restored
            ? "Inline Diff: Diff settings restored."
            : "Inline Diff: No diff settings backup found.",
        );
      }),
    ),
    vscode.commands.registerCommand("inlinediff.acceptFile", (file: unknown) => {
      if (!isWorkspaceChangedFile(file)) {
        return explainContextOnlyCommand();
      }
      let expected: FileContentRevision | undefined;
      return runProjectCommand("Accept File", file.rootUri.fsPath, projectOperationRunner, {
        apply: () =>
          acceptFile(file.rootUri.fsPath, file.relativePath, requirePreparedRevision(expected)),
        prepare: async () => {
          expected = await currentFileActionGuard.assertReady(
            file.rootUri.fsPath,
            file.relativePath,
          );
        },
        refresh: async () => {
          baselineContentProvider.refresh(
            baselineContentProvider.createBaselineUri(file.rootUri, file.relativePath),
          );
          currentContentProvider.refresh(
            currentContentProvider.createCurrentUri(file.rootUri, file.relativePath),
          );
          await refreshController.refreshFile(file.rootUri.fsPath, file.relativePath);
        },
      });
    }),
    vscode.commands.registerCommand("inlinediff.rejectFile", (file: unknown) => {
      if (!isWorkspaceChangedFile(file)) {
        return explainContextOnlyCommand();
      }
      let expected: FileContentRevision | undefined;
      return runProjectCommand("Reject File", file.rootUri.fsPath, projectOperationRunner, {
        apply: () =>
          rejectFile(file.rootUri.fsPath, file.relativePath, requirePreparedRevision(expected)),
        prepare: async () => {
          expected = await currentFileActionGuard.assertReady(
            file.rootUri.fsPath,
            file.relativePath,
          );
        },
        refresh: async () => {
          await reopenEmptyModifiedDiffIfOpen(
            file.rootUri.fsPath,
            file.relativePath,
            baselineContentProvider,
            currentContentProvider,
            inlineDiffEditorRegistry,
          );
          await refreshController.refreshFile(file.rootUri.fsPath, file.relativePath);
        },
      });
    }),
    vscode.commands.registerCommand("inlinediff.acceptAll", async (project: unknown) => {
      if (!isProjectTreeItem(project)) {
        await explainContextOnlyCommand();
        return;
      }
      let summary: Awaited<ReturnType<typeof acceptAllFiles>> | undefined;
      await withNotificationProgress("Inline Diff: Accepting all changes", () =>
        runProjectCommand("Accept All", project.rootUri.fsPath, projectOperationRunner, {
          apply: async () => {
            summary = await acceptAllFiles(project.rootUri.fsPath, (file) =>
              currentFileActionGuard.assertReady(project.rootUri.fsPath, file.relativePath),
            );
          },
          notify: async () => {
            if (summary === undefined) {
              return;
            }
            const actionSummary = summary;
            await runCommand("Accept All", () =>
              showProjectActionSummaryMessage(vscode.window, "accept", actionSummary),
            );
          },
          refresh: async () => {
            for (const file of project.children) {
              baselineContentProvider.refresh(
                baselineContentProvider.createBaselineUri(project.rootUri, file.relativePath),
              );
              currentContentProvider.refresh(
                currentContentProvider.createCurrentUri(project.rootUri, file.relativePath),
              );
            }
            if (summary !== undefined) {
              refreshController.markFilesClean(project.rootUri.fsPath, summary.succeeded);
            }
          },
        }),
      );
    }),
    vscode.commands.registerCommand("inlinediff.rejectAll", async (project: unknown) => {
      if (!isProjectTreeItem(project)) {
        await explainContextOnlyCommand();
        return;
      }
      if (projectOperationRunner.state.isBusy(project.rootUri.fsPath)) {
        void vscode.window.setStatusBarMessage(
          "Inline Diff: Reject All is already running.",
          3_000,
        );
        return;
      }
      await runCommand("Reject All", async () => {
        const confirmation = await vscode.window.showWarningMessage(
          `Reject all changes in ${project.label}? This overwrites current project files.`,
          { modal: true },
          "Reject All",
        );
        if (confirmation !== "Reject All") {
          return;
        }

        let summary: Awaited<ReturnType<typeof rejectAllFiles>> | undefined;
        await withNotificationProgress("Inline Diff: Rejecting all changes", () =>
          runProjectCommand("Reject All", project.rootUri.fsPath, projectOperationRunner, {
            apply: async () => {
              summary = await rejectAllFiles(project.rootUri.fsPath, (file) =>
                currentFileActionGuard.assertReady(project.rootUri.fsPath, file.relativePath),
              );
            },
            notify: async () => {
              if (summary === undefined) {
                return;
              }
              const actionSummary = summary;
              await runCommand("Reject All", () =>
                showProjectActionSummaryMessage(vscode.window, "reject", actionSummary),
              );
            },
            refresh: async () => {
              if (summary !== undefined) {
                refreshController.markFilesClean(project.rootUri.fsPath, summary.succeeded);
              }
            },
          }),
        );
      });
    }),
    vscode.commands.registerCommand("inlinediff.acceptHunk", (args: unknown) => {
      if (!isHunkCommandArguments(args)) {
        return explainContextOnlyCommand();
      }
      if (!isCalledFromOwnDiffEditor()) {
        return;
      }
      let expected: FileContentRevision | undefined;
      return runProjectCommand("Accept Change", args.rootPath, projectOperationRunner, {
        apply: () =>
          acceptHunk(
            args.rootPath,
            args.relativePath,
            args.hunkId,
            requirePreparedRevision(expected),
          ),
        pendingHunk: { hunkId: args.hunkId, relativePath: args.relativePath },
        prepare: async () => {
          expected = await currentFileActionGuard.assertReady(args.rootPath, args.relativePath);
        },
        refresh: async () => {
          baselineContentProvider.refresh(
            baselineContentProvider.createBaselineUri(
              vscode.Uri.file(args.rootPath),
              args.relativePath,
            ),
          );
          currentContentProvider.refresh(
            currentContentProvider.createCurrentUri(
              vscode.Uri.file(args.rootPath),
              args.relativePath,
            ),
          );
          await refreshController.refreshFile(args.rootPath, args.relativePath);
        },
      });
    }),
    vscode.commands.registerCommand("inlinediff.rejectHunk", (args: unknown) => {
      if (!isHunkCommandArguments(args)) {
        return explainContextOnlyCommand();
      }
      if (!isCalledFromOwnDiffEditor()) {
        return;
      }
      let expected: FileContentRevision | undefined;
      return runProjectCommand("Reject Change", args.rootPath, projectOperationRunner, {
        apply: () =>
          rejectHunk(
            args.rootPath,
            args.relativePath,
            args.hunkId,
            requirePreparedRevision(expected),
          ),
        pendingHunk: { hunkId: args.hunkId, relativePath: args.relativePath },
        prepare: async () => {
          expected = await currentFileActionGuard.assertReady(args.rootPath, args.relativePath);
        },
        refresh: async () => {
          currentContentProvider.refresh(
            currentContentProvider.createCurrentUri(
              vscode.Uri.file(args.rootPath),
              args.relativePath,
            ),
          );
          await reopenEmptyModifiedDiffIfOpen(
            args.rootPath,
            args.relativePath,
            baselineContentProvider,
            currentContentProvider,
            inlineDiffEditorRegistry,
          );
          await refreshController.refreshFile(args.rootPath, args.relativePath);
        },
      });
    }),
    vscode.commands.registerCommand("inlinediff.toggleKeepHunk", (args: unknown) => {
      if (!isHunkCommandArguments(args)) {
        return explainContextOnlyCommand();
      }
      return runCommand("Toggle Keep Change", async () => {
        keptHunkStore.toggle(args.rootPath, args.relativePath, args.hunkId);
      });
    }),
    vscode.commands.registerCommand("inlinediff.acceptUnkeptHunks", async (target: unknown) => {
      const files = getHunkBulkTargetFiles(target);
      if (files === undefined) {
        await explainContextOnlyCommand();
        return;
      }
      const [firstFile] = files;
      if (firstFile === undefined) {
        void vscode.window.setStatusBarMessage(
          "Inline Diff: No text inline changes to accept.",
          3_000,
        );
        return;
      }

      const summaries: Array<{
        file: WorkspaceChangedFile;
        summary: HunkActionSummary;
      }> = [];
      await withNotificationProgress("Inline Diff: Accepting inline changes", () =>
        runProjectCommand(
          "Accept Inline Changes Not Kept For Review",
          firstFile.rootUri.fsPath,
          projectOperationRunner,
          {
            apply: async () => {
              for (const file of files) {
                const rootPath = file.rootUri.fsPath;
                summaries.push({
                  file,
                  summary: await acceptUnkeptHunks(
                    rootPath,
                    file.relativePath,
                    changedFilesProvider.getKeptHunkIds(rootPath, file.relativePath),
                    () => currentFileActionGuard.assertReady(rootPath, file.relativePath),
                  ),
                });
              }
            },
            notify: async () => {
              const accepted = summaries.reduce(
                (total, { summary }) => total + summary.succeeded.length,
                0,
              );
              const failed = summaries.reduce(
                (total, { summary }) => total + summary.failed.length,
                0,
              );
              const kept = summaries.reduce((total, { summary }) => total + summary.kept.length, 0);
              const message = `Inline Diff: accepted ${accepted} inline changes, kept ${kept}, failed ${failed}.`;
              if (failed > 0) {
                await vscode.window.showWarningMessage(message);
              } else {
                void vscode.window.setStatusBarMessage(message, 3_000);
              }
            },
            refresh: async () => {
              for (const file of files) {
                baselineContentProvider.refresh(
                  baselineContentProvider.createBaselineUri(file.rootUri, file.relativePath),
                );
                currentContentProvider.refresh(
                  currentContentProvider.createCurrentUri(file.rootUri, file.relativePath),
                );
                await refreshController.refreshFile(file.rootUri.fsPath, file.relativePath);
              }
              hunkCodeLensProvider.refresh();
            },
          },
        ),
      );
    }),
    watchWorkspaceChanges((changedUris) =>
      runCommand("Refresh", async () => {
        if (changedUris.length === 0) {
          await refreshWorkspaceState(
            refreshController,
            context.globalState,
            ignoredUntrustedStoreKeys,
          );
        } else {
          await processChangedFiles(
            changedUris,
            context.globalState,
            fileStabilityTracker,
            refreshController,
          );
        }
        hunkCodeLensProvider.refresh();
      }),
    ),
  );

  void runCommand("Initial Refresh", async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const stores = await discoverWorkspaceStores(folders.map((folder) => folder.uri.fsPath));
    await pruneIgnoredBaselines(context.globalState, stores);
    await refreshWorkspaceState(
      refreshController,
      context.globalState,
      ignoredUntrustedStoreKeys,
      stores,
    );
    // Last on purpose: the tree is already populated, so nobody is waiting on this.
    await collectStartupGarbage(context.globalState, stores);
  });
}

// Once per session, drop baseline entries that .diffignore now ignores (a tracked file edited into
// a rule). Between startups, scans only hide such files; this reclaims the store. Trusted roots
// only — never mutate a store we do not own.
async function pruneIgnoredBaselines(
  storage: TrustedStoreStorage,
  stores: WorkspaceStores,
): Promise<void> {
  const roots = await filterTrustedProjectRoots(stores.projectRoots, storage);
  for (const root of roots) {
    try {
      await untrackIgnoredFiles(root);
    } catch (error) {
      void vscode.window.showErrorMessage(`Inline Diff: ${toErrorMessage(error)}`);
    }
  }
}

// Once per session, reclaim superseded baseline blobs from each trusted internal repository.
// Garbage collection deletes unreferenced objects, so it must never overlap another window's
// write sequence: when the project operation lock is unavailable, skip silently — the next
// activation tries again. Failures never surface; this is housekeeping, not a user action.
async function collectStartupGarbage(
  storage: TrustedStoreStorage,
  stores: WorkspaceStores,
): Promise<void> {
  const roots = await filterTrustedProjectRoots(stores.projectRoots, storage);
  for (const root of roots) {
    try {
      const lease = await tryAcquireProjectOperationLock(root);
      if (lease === undefined) {
        continue;
      }
      try {
        await withProjectGitLock(root, () => collectGarbage(root));
      } finally {
        await lease.release();
      }
    } catch {
      // Best-effort: never block or fail activation for housekeeping.
    }
  }
}

export function deactivate(): void {}

async function selectInitializableWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const initializableRoots = new Set(
    await findInitializableProjectRoots(folders.map((folder) => folder.uri.fsPath)),
  );
  const candidates = folders.filter((folder) => initializableRoots.has(folder.uri.fsPath));
  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    candidates.map((folder) => ({
      description: folder.uri.fsPath,
      folder,
      label: folder.name,
    })),
    {
      placeHolder: "Select a workspace folder to initialize Inline Diff",
    },
  );
  return selected?.folder;
}

async function openDiff(
  file: WorkspaceChangedFile,
  baselineContentProvider: BaselineContentProvider,
  currentContentProvider: CurrentContentProvider,
  registry: InlineDiffEditorRegistry,
  line?: number,
): Promise<void> {
  const emptyModifiedUri = baselineContentProvider.createEmptyUri(
    file.rootUri,
    file.relativePath,
    "modified",
  );
  const baselineUri = baselineContentProvider.createBaselineUri(file.rootUri, file.relativePath);
  const currentUri =
    file.kind === "deleted"
      ? emptyModifiedUri
      : currentContentProvider.createCurrentUri(file.rootUri, file.relativePath);
  registry.register({
    baselineUri,
    modifiedUri: currentUri,
    relativePath: file.relativePath,
    rootPath: file.rootUri.fsPath,
  });

  await vscode.commands.executeCommand(
    "vscode.diff",
    baselineUri,
    currentUri,
    `Inline Diff: ${file.relativePath}`,
    line === undefined ? undefined : { selection: new vscode.Range(line, 0, line, 0) },
  );
}

async function reopenEmptyModifiedDiffIfOpen(
  rootPath: string,
  relativePath: string,
  baselineContentProvider: BaselineContentProvider,
  currentContentProvider: CurrentContentProvider,
  registry: InlineDiffEditorRegistry,
): Promise<void> {
  const emptyModifiedUri = baselineContentProvider.createEmptyUri(
    vscode.Uri.file(rootPath),
    relativePath,
    "modified",
  );
  if (
    !vscode.workspace.textDocuments.some(
      (document) => document.uri.toString() === emptyModifiedUri.toString(),
    )
  ) {
    return;
  }
  await openDiff(
    {
      description: "M",
      kind: "modified",
      relativePath,
      rootUri: vscode.Uri.file(rootPath),
    },
    baselineContentProvider,
    currentContentProvider,
    registry,
  );
}

function isCalledFromOwnDiffEditor(): boolean {
  // Our CodeLens only attaches to the baseline/current schemes, so when the active tab is
  // indeterminate we allow the action rather than block a legitimate invocation.
  const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
  if (tab === undefined || tab === null) {
    return true;
  }
  if (!(tab.input instanceof vscode.TabInputTextDiff)) {
    return true;
  }
  return tab.input.original.scheme === baselineContentScheme;
}

function createDiffSettingsAdapter(folder: vscode.WorkspaceFolder): DiffSettingsAdapter {
  const config = (key: string) => {
    const dot = key.indexOf(".");
    return vscode.workspace
      .getConfiguration(key.slice(0, dot), folder.uri)
      .inspect<boolean>(key.slice(dot + 1));
  };
  return {
    getBoolean: (key) => {
      const dot = key.indexOf(".");
      return vscode.workspace
        .getConfiguration(key.slice(0, dot), folder.uri)
        .get<boolean>(key.slice(dot + 1));
    },
    getWorkspaceFolderBoolean: (key) => config(key)?.workspaceFolderValue,
    setWorkspaceFolderBoolean: async (key, value) => {
      const dot = key.indexOf(".");
      await vscode.workspace
        .getConfiguration(key.slice(0, dot), folder.uri)
        .update(key.slice(dot + 1), value, vscode.ConfigurationTarget.WorkspaceFolder);
    },
  };
}

export interface ChangedFilesRefreshLifecycle {
  handleFileEvent(rootPath: string, relativePath: string): Promise<void>;
}

interface WorkspaceRefreshLifecycle {
  pruneProjects(retainedRoots: readonly string[]): void;
  refreshWorkspaceForeground(projectRoots: readonly string[]): Promise<void>;
}

interface FileStabilityLifecycle {
  markChanged(rootPath: string, relativePath: string): void;
}

export async function processChangedFiles(
  changedUris: readonly vscode.Uri[],
  storage: TrustedStoreStorage,
  stabilityTracker: FileStabilityLifecycle,
  refreshController: ChangedFilesRefreshLifecycle,
): Promise<void> {
  const changes: { relativePath: string; rootPath: string }[] = [];
  for (const uri of changedUris) {
    try {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder === undefined) {
        continue;
      }
      // The workspace folder is the project root; we never look for a nested .inlinediff. A change
      // outside a trusted project (folder has no store, or it is untrusted) is skipped.
      const rootPath = folder.uri.fsPath;
      if (!(await isProjectStoreTrusted(storage, rootPath))) {
        continue;
      }
      changes.push({
        relativePath: normalizeRelativePath(relative(rootPath, uri.fsPath)),
        rootPath,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`Inline Diff: Refresh failed. ${toErrorMessage(error)}`);
    }
  }
  await processWorkspaceChanges(
    changes,
    ({ relativePath, rootPath }) => stabilityTracker.markChanged(rootPath, relativePath),
    ({ relativePath, rootPath }) => refreshController.handleFileEvent(rootPath, relativePath),
    (error) =>
      void vscode.window.showErrorMessage(`Inline Diff: Refresh failed. ${toErrorMessage(error)}`),
  );
}

async function runCommand(name: string, command: () => Promise<unknown>): Promise<void> {
  try {
    await command();
  } catch (error) {
    void vscode.window.showErrorMessage(`Inline Diff: ${name} failed. ${toErrorMessage(error)}`);
  }
}

async function withNotificationProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
    },
    task,
  );
}

async function refreshWorkspaceState(
  refreshController: WorkspaceRefreshLifecycle,
  storage: TrustedStoreStorage,
  ignoredUntrustedStoreKeys: Set<string>,
  stores?: WorkspaceStores,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const workspaceRoots = folders.map((folder) => folder.uri.fsPath);
  // One workspace walk feeds untrusted resolution and the foreground scan. Callers that already
  // walked (startup) pass it in; the rest walk once here.
  const resolvedStores = stores ?? (await discoverWorkspaceStores(workspaceRoots));
  await resolveUntrustedStores(resolvedStores.storeRoots, storage, ignoredUntrustedStoreKeys);
  const trustedRoots = await filterTrustedProjectRoots(resolvedStores.projectRoots, storage);
  // Drop any project that is no longer trusted/present (folder removed, store untrusted) before
  // re-scanning the trusted ones, so a stale project does not linger in the tree.
  refreshController.pruneProjects(trustedRoots);
  await refreshController.refreshWorkspaceForeground(trustedRoots);
  const initializableRoots = await findInitializableProjectRoots(workspaceRoots);
  await vscode.commands.executeCommand(
    "setContext",
    "inlinediff.canInitialize",
    initializableRoots.length > 0,
  );
}

async function resolveUntrustedStores(
  storeRoots: readonly string[],
  storage: TrustedStoreStorage,
  ignoredUntrustedStoreKeys: Set<string>,
): Promise<void> {
  const untrustedRoots = await filterUntrustedStoreRoots(
    storeRoots,
    storage,
    ignoredUntrustedStoreKeys,
  );
  for (const rootPath of untrustedRoots) {
    await resolveUntrustedProjectStore({
      ignoredStoreKeys: ignoredUntrustedStoreKeys,
      messages: vscode.window,
      rootPath,
      storage,
    });
  }
}

function isCurrentFileDirty(rootPath: string, relativePath: string): boolean {
  const currentUri = vscode.Uri.joinPath(vscode.Uri.file(rootPath), relativePath);
  return vscode.workspace.textDocuments.some(
    (document) => document.uri.toString() === currentUri.toString() && document.isDirty,
  );
}

function requirePreparedRevision(revision: FileContentRevision | undefined): FileContentRevision {
  if (revision === undefined) {
    throw new Error("Project operation was not prepared.");
  }
  return revision;
}

function explainContextOnlyCommand(): Thenable<string | undefined> {
  return vscode.window.showInformationMessage(
    "Inline Diff: Use this command from the Changed Files view or Inline Diff editor.",
  );
}

function isWorkspaceChangedFile(value: unknown): value is WorkspaceChangedFile {
  if (!isRecord(value) || !isRecord(value.rootUri)) {
    return false;
  }
  return (
    typeof value.relativePath === "string" &&
    typeof value.kind === "string" &&
    typeof value.rootUri.fsPath === "string"
  );
}

function isProjectTreeItem(value: unknown): value is ProjectTreeItem {
  if (!isRecord(value) || !isRecord(value.rootUri)) {
    return false;
  }
  return Array.isArray(value.children) && typeof value.rootUri.fsPath === "string";
}

function isHunkCommandArguments(value: unknown): value is HunkCommandArguments {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.rootPath === "string" &&
    typeof value.relativePath === "string" &&
    typeof value.hunkId === "string"
  );
}

function getHunkBulkTargetFiles(target: unknown): WorkspaceChangedFile[] | undefined {
  if (isWorkspaceChangedFile(target)) {
    return canAcceptTextHunks(target) ? [target] : [];
  }
  if (isProjectTreeItem(target)) {
    return target.children.filter(canAcceptTextHunks);
  }
  return undefined;
}

function canAcceptTextHunks(file: WorkspaceChangedFile): boolean {
  return file.kind !== "binary-modified";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ProjectCommandLifecycle {
  readonly apply: () => Promise<void>;
  readonly notify?: (() => Promise<void>) | undefined;
  readonly pendingHunk?: PendingHunk | undefined;
  readonly prepare?: (() => Promise<void>) | undefined;
  readonly refresh?: (() => Promise<void>) | undefined;
}

async function runProjectCommand(
  name: string,
  rootPath: string,
  runner: ProjectOperationRunner,
  lifecycle: ProjectCommandLifecycle,
): Promise<void> {
  // Fast pre-check for a friendly per-command message. runner.run re-checks atomically via
  // state.begin, which is the authoritative guard against a concurrent start.
  if (runner.state.isBusy(rootPath)) {
    void vscode.window.setStatusBarMessage(`Inline Diff: ${name} is already running.`, 3_000);
    return;
  }

  const status = vscode.window.setStatusBarMessage(`Inline Diff: Processing ${name}...`);
  try {
    await runCommand(name, async () => {
      const ran = await runner.run({
        apply: lifecycle.apply,
        name,
        notify: lifecycle.notify,
        pendingHunk: lifecycle.pendingHunk,
        prepare: lifecycle.prepare,
        refresh: lifecycle.refresh,
        rootPath,
      });
      if (!ran) {
        void vscode.window.setStatusBarMessage(
          "Inline Diff: another operation is already running for this project.",
          3_000,
        );
      }
    });
  } finally {
    status.dispose();
  }
}
