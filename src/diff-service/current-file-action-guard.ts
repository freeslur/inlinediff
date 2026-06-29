import type { FileContentRevision } from "./file-content-revision.ts";
import { readFileContentRevision } from "./file-content-revision.ts";
import { resolveSafeProjectPath } from "./project-path.ts";

export type ChangingPredicate = (rootPath: string, relativePath: string) => boolean;
export type DirtyPredicate = (rootPath: string, relativePath: string) => boolean;
export type CurrentRevisionReader = (
  rootPath: string,
  relativePath: string,
) => Promise<FileContentRevision>;

export interface CurrentFileActionGuardOptions {
  readonly isChanging: ChangingPredicate;
  readonly isDirty: DirtyPredicate;
  readonly readRevision?: CurrentRevisionReader;
}

export class CurrentFileStillChangingError extends Error {
  constructor(readonly relativePath: string) {
    super(`File is still changing: ${relativePath}`);
  }
}

export class CurrentFileDirtyError extends Error {
  constructor(readonly relativePath: string) {
    super(`Unsaved changes: ${relativePath}`);
  }
}

const defaultRevisionReader: CurrentRevisionReader = async (rootPath, relativePath) =>
  readFileContentRevision(await resolveSafeProjectPath(rootPath, relativePath));

export class CurrentFileActionGuard {
  readonly #isChanging: ChangingPredicate;
  readonly #isDirty: DirtyPredicate;
  readonly #readRevision: CurrentRevisionReader;

  constructor(options: CurrentFileActionGuardOptions) {
    this.#isChanging = options.isChanging;
    this.#isDirty = options.isDirty;
    this.#readRevision = options.readRevision ?? defaultRevisionReader;
  }

  async assertReady(rootPath: string, relativePath: string): Promise<FileContentRevision> {
    if (this.#isChanging(rootPath, relativePath)) {
      throw new CurrentFileStillChangingError(relativePath);
    }
    if (this.#isDirty(rootPath, relativePath)) {
      throw new CurrentFileDirtyError(relativePath);
    }
    return this.#readRevision(rootPath, relativePath);
  }
}
