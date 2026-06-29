import { platform } from "node:os";
import { resolve } from "node:path";

export interface PendingHunk {
  hunkId: string;
  relativePath: string;
}

export interface ProjectOperation {
  pendingHunk?: PendingHunk;
  projectKey: string;
}

export class ProjectOperationState {
  readonly #activeByProject = new Map<string, ProjectOperation>();

  begin(rootPath: string, pendingHunk?: PendingHunk): ProjectOperation | undefined {
    const key = projectKey(rootPath);
    if (this.#activeByProject.has(key)) {
      return undefined;
    }
    const operation: ProjectOperation =
      pendingHunk === undefined ? { projectKey: key } : { pendingHunk, projectKey: key };
    this.#activeByProject.set(key, operation);
    return operation;
  }

  end(operation: ProjectOperation): void {
    if (this.#activeByProject.get(operation.projectKey) === operation) {
      this.#activeByProject.delete(operation.projectKey);
    }
  }

  isBusy(rootPath: string): boolean {
    return this.#activeByProject.has(projectKey(rootPath));
  }

  isPendingHunk(rootPath: string, relativePath: string, hunkId: string): boolean {
    const pending = this.#activeByProject.get(projectKey(rootPath))?.pendingHunk;
    return pending?.relativePath === relativePath && pending.hunkId === hunkId;
  }
}

function projectKey(rootPath: string): string {
  const resolved = resolve(rootPath);
  return platform() === "win32" ? resolved.toLowerCase() : resolved;
}
