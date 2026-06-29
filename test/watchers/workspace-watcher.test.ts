import { describe, expect, mock, test } from "bun:test";
import type { RefreshTimer, RefreshTimerScheduler } from "../../src/watchers/file-refresh-queue.ts";
import type {
  WorkspaceFolderChange,
  WorkspaceWatchHost,
} from "../../src/watchers/workspace-watcher.ts";

// The watcher never touches vscode.* when a host is injected; this minimal mock only lets the
// module's `import * as vscode` resolve when this file runs in isolation.
mock.module("vscode", () => ({}));

interface FakeUri {
  readonly path: string;
  toString(): string;
}

const fakeUri = (path: string): FakeUri => ({ path, toString: () => `file://${path}` });

interface FakeFolder {
  readonly uri: FakeUri;
}

class FakeWatcher {
  readonly listeners: Array<(uri: FakeUri) => void> = [];
  disposed = false;

  dispose(): void {
    this.disposed = true;
  }
  onDidChange(listener: (uri: FakeUri) => void) {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  }
  onDidCreate(listener: (uri: FakeUri) => void) {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  }
  onDidDelete(listener: (uri: FakeUri) => void) {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  }
}

interface TestHost {
  readonly host: WorkspaceWatchHost;
  readonly createdWatchers: FakeWatcher[];
  changeFolders(change: { added?: FakeFolder[]; removed?: FakeFolder[] }): void;
}

function createTestHost(folders: FakeFolder[]): TestHost {
  const createdWatchers: FakeWatcher[] = [];
  let handler: ((change: WorkspaceFolderChange) => void) | undefined;
  const host = {
    workspaceFolders: folders,
    createWatcher: () => {
      const watcher = new FakeWatcher();
      createdWatchers.push(watcher);
      return watcher;
    },
    onDidChangeWorkspaceFolders: (registered: (change: WorkspaceFolderChange) => void) => {
      handler = registered;
      return { dispose: () => undefined };
    },
    reportError: () => undefined,
  } as unknown as WorkspaceWatchHost;
  return {
    createdWatchers,
    host,
    changeFolders: ({ added = [], removed = [] }) =>
      handler?.({ added, removed } as unknown as WorkspaceFolderChange),
  };
}

class ManualScheduler implements RefreshTimerScheduler {
  #now = 0;
  #nextId = 0;
  readonly #timers = new Map<number, { cb: () => void; due: number }>();

  setTimeout(callback: () => void, delayMilliseconds: number): RefreshTimer {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, { cb: callback, due: this.#now + delayMilliseconds });
    return { cancel: () => this.#timers.delete(id) };
  }

  advanceBy(milliseconds: number): void {
    const target = this.#now + milliseconds;
    while (true) {
      let next: { cb: () => void; due: number; id: number } | undefined;
      for (const [id, timer] of this.#timers) {
        if (
          timer.due <= target &&
          (next === undefined || timer.due < next.due || (timer.due === next.due && id < next.id))
        ) {
          next = { cb: timer.cb, due: timer.due, id };
        }
      }
      if (next === undefined) {
        break;
      }
      this.#now = next.due;
      this.#timers.delete(next.id);
      next.cb();
    }
    this.#now = target;
  }
}

async function loadWatcher() {
  return (await import("../../src/watchers/workspace-watcher.ts")).watchWorkspaceChanges;
}

describe("watchWorkspaceChanges", () => {
  test("ignores changes inside structurally excluded folders, refreshes others", async () => {
    const { host, createdWatchers } = createTestHost([{ uri: fakeUri("/proj") }]);
    const scheduler = new ManualScheduler();
    const changed: string[][] = [];
    const watchWorkspaceChanges = await loadWatcher();

    const subscription = watchWorkspaceChanges(
      async (uris) => {
        changed.push(uris.map((uri) => uri.path));
      },
      { host, scheduler },
    );
    const watcher = createdWatchers[0];
    if (watcher === undefined) {
      throw new Error("Expected a watcher to be created.");
    }

    watcher.listeners[0]?.(fakeUri("/proj/.inlinediff/repository/index"));
    watcher.listeners[0]?.(fakeUri("/proj/src/app.ts"));
    scheduler.advanceBy(1_000);

    expect(changed).toEqual([["/proj/src/app.ts"]]);
    subscription.dispose();
  });

  test("disposes a folder's watcher when that folder is removed", async () => {
    const folder = { uri: fakeUri("/proj") };
    const { host, createdWatchers, changeFolders } = createTestHost([folder]);
    const watchWorkspaceChanges = await loadWatcher();

    const subscription = watchWorkspaceChanges(async () => undefined, { host });
    const watcher = createdWatchers[0];
    if (watcher === undefined) {
      throw new Error("Expected a watcher to be created.");
    }
    expect(watcher.disposed).toBe(false);

    changeFolders({ removed: [folder] });

    expect(watcher.disposed).toBe(true);
    subscription.dispose();
  });

  test("does not create a second watcher for an already-watched folder", async () => {
    const folder = { uri: fakeUri("/proj") };
    const { host, createdWatchers, changeFolders } = createTestHost([folder]);
    const watchWorkspaceChanges = await loadWatcher();

    const subscription = watchWorkspaceChanges(async () => undefined, { host });
    changeFolders({ added: [folder] });

    expect(createdWatchers).toHaveLength(1);
    subscription.dispose();
  });

  test("disposes every watcher when the subscription is disposed", async () => {
    const { host, createdWatchers } = createTestHost([
      { uri: fakeUri("/a") },
      { uri: fakeUri("/b") },
    ]);
    const watchWorkspaceChanges = await loadWatcher();

    const subscription = watchWorkspaceChanges(async () => undefined, { host });
    expect(createdWatchers).toHaveLength(2);

    subscription.dispose();

    expect(createdWatchers.every((watcher) => watcher.disposed)).toBe(true);
  });
});
