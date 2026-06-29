export type KeptHunkStoreListener = () => void;

export class KeptHunkStore {
  readonly #keptHunkKeys = new Set<string>();
  readonly #listeners = new Set<KeptHunkStoreListener>();

  isKept(rootPath: string, relativePath: string, hunkId: string): boolean {
    return this.#keptHunkKeys.has(hunkKey(rootPath, relativePath, hunkId));
  }

  keptIdsFor(rootPath: string, relativePath: string): ReadonlySet<string> {
    const prefix = hunkKeyPrefix(rootPath, relativePath);
    return new Set(
      [...this.#keptHunkKeys]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    );
  }

  onDidChange(listener: KeptHunkStoreListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  retainHunks(rootPath: string, relativePath: string, liveIds: ReadonlySet<string>): void {
    const prefix = hunkKeyPrefix(rootPath, relativePath);
    let changed = false;
    for (const key of this.#keptHunkKeys) {
      if (key.startsWith(prefix) && !liveIds.has(key.slice(prefix.length))) {
        this.#keptHunkKeys.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.#notify();
    }
  }

  setKept(rootPath: string, relativePath: string, hunkId: string, kept: boolean): void {
    const key = hunkKey(rootPath, relativePath, hunkId);
    const hadKey = this.#keptHunkKeys.has(key);
    if (kept) {
      this.#keptHunkKeys.add(key);
    } else {
      this.#keptHunkKeys.delete(key);
    }
    if (hadKey !== kept) {
      this.#notify();
    }
  }

  toggle(rootPath: string, relativePath: string, hunkId: string): boolean {
    const kept = !this.isKept(rootPath, relativePath, hunkId);
    this.setKept(rootPath, relativePath, hunkId, kept);
    return kept;
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

function hunkKey(rootPath: string, relativePath: string, hunkId: string): string {
  return `${hunkKeyPrefix(rootPath, relativePath)}${hunkId}`;
}

function hunkKeyPrefix(rootPath: string, relativePath: string): string {
  return `${rootPath}\0${relativePath}\0`;
}
