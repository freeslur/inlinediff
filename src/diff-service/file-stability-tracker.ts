import { platform } from "node:os";
import { resolve } from "node:path";
import type { FileContentRevision } from "./file-content-revision.ts";
import { readFileContentRevision } from "./file-content-revision.ts";
import {
  normalizeRelativePath,
  resolveProjectPath,
  resolveSafeProjectPath,
} from "./project-path.ts";

export type StabilityCheck = () => Promise<void>;
export type StabilityScheduler = (check: StabilityCheck, delayMilliseconds: number) => void;
export type RevisionReader = (
  rootPath: string,
  relativePath: string,
) => Promise<FileContentRevision>;
export type FileStabilityListener = (event: FileStabilityStatusEvent) => void;

export interface FileStabilityStatusEvent {
  readonly changing: boolean;
  readonly relativePath: string;
  readonly rootPath: string;
}

export interface FileStabilityTrackerOptions {
  readonly debounceMilliseconds?: number;
  readonly readRevision?: RevisionReader;
  readonly schedule?: StabilityScheduler;
}

interface FileStabilityEntry {
  changing: boolean;
  generation: number;
}

const defaultDebounceMilliseconds = 150;
// A revision read that keeps failing (e.g. the path was replaced by a symlink) must
// not reschedule forever. After the cap, treat the file as stable so the actual
// accept/reject path surfaces the real error instead of staying silently "changing".
const maxStabilityCheckAttempts = 20;

const defaultScheduler: StabilityScheduler = (check, delayMilliseconds) => {
  setTimeout(() => void check(), delayMilliseconds).unref();
};

const defaultRevisionReader: RevisionReader = async (rootPath, relativePath) =>
  readFileContentRevision(await resolveSafeProjectPath(rootPath, relativePath));

export class FileStabilityTracker {
  readonly #debounceMilliseconds: number;
  readonly #entries = new Map<string, FileStabilityEntry>();
  readonly #listeners = new Set<FileStabilityListener>();
  readonly #readRevision: RevisionReader;
  readonly #schedule: StabilityScheduler;

  constructor(options: FileStabilityTrackerOptions = {}) {
    this.#debounceMilliseconds = options.debounceMilliseconds ?? defaultDebounceMilliseconds;
    this.#readRevision = options.readRevision ?? defaultRevisionReader;
    this.#schedule = options.schedule ?? defaultScheduler;
  }

  markChanged(rootPath: string, relativePath: string): number {
    const entry = this.#entry(rootPath, relativePath);
    const wasChanging = entry.changing;
    entry.changing = true;
    entry.generation += 1;
    if (!wasChanging) {
      this.#notify(rootPath, relativePath, true);
    }
    const generation = entry.generation;
    this.#schedule(
      () => this.#completeStabilityCheck(rootPath, relativePath, generation),
      this.#debounceMilliseconds,
    );
    return generation;
  }

  onDidChangeStatus(listener: FileStabilityListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  isChanging(rootPath: string, relativePath: string): boolean {
    return this.#entries.get(fileKey(rootPath, relativePath))?.changing ?? false;
  }

  async #completeStabilityCheck(
    rootPath: string,
    relativePath: string,
    generation: number,
    attempt = 0,
  ): Promise<void> {
    const entry = this.#entries.get(fileKey(rootPath, relativePath));
    if (entry === undefined || entry.generation !== generation) {
      return;
    }

    try {
      await this.#readRevision(rootPath, relativePath);
    } catch {
      if (entry.generation === generation && attempt + 1 < maxStabilityCheckAttempts) {
        this.#schedule(
          () => this.#completeStabilityCheck(rootPath, relativePath, generation, attempt + 1),
          this.#debounceMilliseconds,
        );
        return;
      }
      // Give up after the cap: mark stable so the action path surfaces the real error.
    }

    if (entry.generation !== generation) {
      return;
    }
    entry.changing = false;
    this.#notify(rootPath, relativePath, false);
  }

  #entry(rootPath: string, relativePath: string): FileStabilityEntry {
    const key = fileKey(rootPath, relativePath);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { changing: false, generation: 0 };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #notify(rootPath: string, relativePath: string, changing: boolean): void {
    for (const listener of this.#listeners) {
      // Isolate listeners: one that throws must not skip the rest or abort the state transition
      // (the entry's `changing` flag is already updated before this runs).
      try {
        listener({ changing, relativePath, rootPath });
      } catch {}
    }
  }
}

function fileKey(rootPath: string, relativePath: string): string {
  resolveProjectPath(rootPath, relativePath);
  const key = `${resolve(rootPath)}\0${normalizeRelativePath(relativePath)}`;
  return platform() === "win32" ? key.toLowerCase() : key;
}
