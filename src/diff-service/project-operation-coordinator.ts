import {
  type ProjectOperationLease,
  tryAcquireProjectOperationLock,
} from "./project-operation-lock.ts";
import { type PendingHunk, ProjectOperationState } from "./project-operation-state.ts";

export class ProjectOperationCoordinator {
  readonly state: ProjectOperationState;

  constructor(
    state = new ProjectOperationState(),
    private readonly onStateChange: () => void = () => undefined,
  ) {
    this.state = state;
  }

  async run(
    rootPath: string,
    pendingHunk: PendingHunk | undefined,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    const active = this.state.begin(rootPath, pendingHunk);
    if (active === undefined) {
      return false;
    }

    this.onStateChange();
    let lease: ProjectOperationLease | undefined;
    try {
      lease = await tryAcquireProjectOperationLock(rootPath);
      if (lease === undefined) {
        return false;
      }
      await operation();
      return true;
    } finally {
      try {
        await lease?.release();
      } finally {
        this.state.end(active);
        this.onStateChange();
      }
    }
  }
}
