import { ProjectOperationCoordinator } from "./project-operation-coordinator.ts";
import type { PendingHunk } from "./project-operation-state.ts";

export interface ProjectOperationDefinition {
  readonly apply: () => Promise<void>;
  readonly name: string;
  readonly notify?: (() => Promise<void>) | undefined;
  readonly pendingHunk?: PendingHunk | undefined;
  readonly prepare?: (() => Promise<void>) | undefined;
  readonly refresh?: (() => Promise<void>) | undefined;
  readonly rootPath: string;
}

export class ProjectOperationRunner {
  constructor(private readonly coordinator = new ProjectOperationCoordinator()) {}

  get state() {
    return this.coordinator.state;
  }

  async run(operation: ProjectOperationDefinition): Promise<boolean> {
    const ran = await this.coordinator.run(operation.rootPath, operation.pendingHunk, async () => {
      await operation.prepare?.();
      await operation.apply();
      await operation.refresh?.();
    });
    if (!ran) {
      return false;
    }
    // notify runs after the lock and state are released and is deliberately not awaited: it only
    // surfaces a result the caller already captured. Never move state re-validation into it.
    void operation.notify?.();
    return true;
  }
}
