import type { FileChangeKind } from "../diff-service/change-kind.ts";

export type ProjectScanState = "idle" | "foreground-scanning" | "background-scanning";

export interface ScannedFileLike {
  readonly kind: FileChangeKind | "clean";
  readonly relativePath: string;
}

export interface ProjectSnapshot {
  readonly files: ScannedFileLike[];
  readonly rootPath: string;
  readonly scanState: ProjectScanState;
}

export interface RefreshPolicy {
  readonly maxChangedEventsSinceFullScan?: number;
  readonly maxChangedFilesSinceFullScan?: number;
}

export interface FileRefreshToken {
  readonly generation: number;
  readonly relativePath: string;
  readonly rootPath: string;
}

export type ChangedFilesStoreListener = () => void;

interface ProjectState {
  changedEventCountSinceFullScan: number;
  changedFileSetSinceFullScan: Set<string>;
  entries: Map<string, ScannedFileLike>;
  generation: number;
  scanState: ProjectScanState;
}

const defaultRefreshPolicy: Required<RefreshPolicy> = {
  maxChangedEventsSinceFullScan: 300,
  maxChangedFilesSinceFullScan: 100,
};

export class ChangedFilesStore {
  readonly #listeners = new Set<ChangedFilesStoreListener>();
  readonly #policy: Required<RefreshPolicy>;
  readonly #projects = new Map<string, ProjectState>();

  constructor(policy: RefreshPolicy = {}) {
    this.#policy = {
      maxChangedEventsSinceFullScan:
        policy.maxChangedEventsSinceFullScan ?? defaultRefreshPolicy.maxChangedEventsSinceFullScan,
      maxChangedFilesSinceFullScan:
        policy.maxChangedFilesSinceFullScan ?? defaultRefreshPolicy.maxChangedFilesSinceFullScan,
    };
  }

  beginFileRefresh(rootPath: string, relativePath: string): FileRefreshToken {
    return {
      generation: this.#project(rootPath).generation,
      relativePath,
      rootPath,
    };
  }

  beginProjectScan(rootPath: string, mode: "background" | "foreground"): number {
    const project = this.#project(rootPath);
    project.generation += 1;
    project.scanState = mode === "background" ? "background-scanning" : "foreground-scanning";
    this.#notify();
    return project.generation;
  }

  cancelProjectScan(rootPath: string, generation: number): boolean {
    const project = this.#project(rootPath);
    if (project.generation !== generation) {
      return false;
    }
    project.scanState = "idle";
    this.#notify();
    return true;
  }

  finishProjectScan(
    rootPath: string,
    generation: number,
    files: readonly ScannedFileLike[],
  ): boolean {
    const project = this.#project(rootPath);
    if (project.generation !== generation) {
      return false;
    }
    this.#replaceProject(project, files);
    this.#notify();
    return true;
  }

  onDidChange(listener: ChangedFilesStoreListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  recordFileEvent(rootPath: string, relativePath: string): { escalate: boolean } {
    const project = this.#project(rootPath);
    project.changedEventCountSinceFullScan += 1;
    project.changedFileSetSinceFullScan.add(relativePath);
    return {
      escalate:
        project.changedEventCountSinceFullScan >= this.#policy.maxChangedEventsSinceFullScan ||
        project.changedFileSetSinceFullScan.size >= this.#policy.maxChangedFilesSinceFullScan,
    };
  }

  replaceProject(rootPath: string, files: readonly ScannedFileLike[]): void {
    this.#replaceProject(this.#project(rootPath), files);
    this.#notify();
  }

  // Drops projects whose root is no longer managed (workspace folder removed or store untrusted) so
  // they stop showing in the tree. A late scan may transiently re-create one; the next prune clears
  // it, which is acceptable for display state.
  retainProjects(rootPaths: readonly string[]): void {
    const keep = new Set(rootPaths);
    let removed = false;
    for (const rootPath of [...this.#projects.keys()]) {
      if (!keep.has(rootPath)) {
        this.#projects.delete(rootPath);
        removed = true;
      }
    }
    if (removed) {
      this.#notify();
    }
  }

  snapshot(): ProjectSnapshot[] {
    return [...this.#projects.entries()].map(([rootPath, project]) => ({
      files: [...project.entries.values()],
      rootPath,
      scanState: project.scanState,
    }));
  }

  updateFile(rootPath: string, file: ScannedFileLike): void {
    this.#updateFile(this.#project(rootPath), file);
    this.#notify();
  }

  updateFiles(rootPath: string, files: readonly ScannedFileLike[]): void {
    const project = this.#project(rootPath);
    for (const file of files) {
      this.#updateFile(project, file);
    }
    this.#notify();
  }

  updateFileIfCurrent(token: FileRefreshToken, file: ScannedFileLike): boolean {
    const project = this.#project(token.rootPath);
    if (project.generation !== token.generation) {
      return false;
    }
    this.#updateFile(project, file);
    this.#notify();
    return true;
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #project(rootPath: string): ProjectState {
    let project = this.#projects.get(rootPath);
    if (project === undefined) {
      project = {
        changedEventCountSinceFullScan: 0,
        changedFileSetSinceFullScan: new Set(),
        entries: new Map(),
        generation: 0,
        scanState: "idle",
      };
      this.#projects.set(rootPath, project);
    }
    return project;
  }

  #replaceProject(project: ProjectState, files: readonly ScannedFileLike[]): void {
    project.entries = new Map(
      files.filter((file) => file.kind !== "clean").map((file) => [file.relativePath, file]),
    );
    project.changedEventCountSinceFullScan = 0;
    project.changedFileSetSinceFullScan = new Set();
    project.scanState = "idle";
  }

  #updateFile(project: ProjectState, file: ScannedFileLike): void {
    if (file.kind === "clean") {
      project.entries.delete(file.relativePath);
      return;
    }
    project.entries.set(file.relativePath, file);
  }
}
