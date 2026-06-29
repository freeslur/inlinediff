import type { ChangedFilesStore, ScannedFileLike } from "./changed-files-store.ts";

export interface ChangedFilesRefreshControllerDependencies {
  readonly classifyFile: (rootPath: string, relativePath: string) => Promise<ScannedFileLike>;
  readonly scanProject: (rootPath: string) => Promise<ScannedFileLike[]>;
}

export class ChangedFilesRefreshController {
  constructor(
    private readonly store: ChangedFilesStore,
    private readonly dependencies: ChangedFilesRefreshControllerDependencies,
  ) {}

  async handleFileEvent(rootPath: string, relativePath: string): Promise<void> {
    if (relativePath === ".diffignore") {
      await this.refreshProjectBackground(rootPath);
      return;
    }

    const { escalate } = this.store.recordFileEvent(rootPath, relativePath);
    if (escalate) {
      await this.refreshProjectBackground(rootPath);
      return;
    }
    await this.refreshFile(rootPath, relativePath);
  }

  pruneProjects(retainedRoots: readonly string[]): void {
    this.store.retainProjects(retainedRoots);
  }

  markFilesClean(rootPath: string, relativePaths: readonly string[]): void {
    // Called only after an accept/reject finishes, and those are serialized per project, so this can
    // update the store directly — no refresh-generation token is needed to fend off a stale scan.
    this.store.updateFiles(
      rootPath,
      relativePaths.map((relativePath) => ({ kind: "clean", relativePath })),
    );
  }

  async refreshFile(rootPath: string, relativePath: string): Promise<void> {
    const token = this.store.beginFileRefresh(rootPath, relativePath);
    this.store.updateFileIfCurrent(
      token,
      await this.dependencies.classifyFile(rootPath, relativePath),
    );
  }

  async refreshProjectBackground(rootPath: string): Promise<void> {
    const generation = this.store.beginProjectScan(rootPath, "background");
    try {
      this.store.finishProjectScan(
        rootPath,
        generation,
        await this.dependencies.scanProject(rootPath),
      );
    } catch (error) {
      this.store.cancelProjectScan(rootPath, generation);
      throw error;
    }
  }

  async refreshWorkspaceForeground(projectRoots: readonly string[]): Promise<void> {
    await Promise.all(
      projectRoots.map(async (rootPath) => {
        const generation = this.store.beginProjectScan(rootPath, "foreground");
        try {
          this.store.finishProjectScan(
            rootPath,
            generation,
            await this.dependencies.scanProject(rootPath),
          );
        } catch (error) {
          this.store.cancelProjectScan(rootPath, generation);
          throw error;
        }
      }),
    );
  }
}
