import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isMissingPathError } from "../errors/fs-errors.ts";

export interface MissingFileContentRevision {
  exists: false;
}

export interface ExistingFileContentRevision {
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  exists: true;
  gid: bigint;
  hash: string;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  size: bigint;
  uid: bigint;
}

export type FileContentRevision = ExistingFileContentRevision | MissingFileContentRevision;

export type FileContentSnapshot =
  | { readonly content: Buffer; readonly revision: ExistingFileContentRevision }
  | { readonly content: undefined; readonly revision: MissingFileContentRevision };

export class FileChangedDuringReadError extends Error {
  constructor(path: string) {
    super(`File changed while reading: ${path}`);
  }
}

export async function readFileContentRevision(path: string): Promise<FileContentRevision> {
  return (await readFileContentSnapshot(path)).revision;
}

export async function readFileContentSnapshot(path: string): Promise<FileContentSnapshot> {
  const before = await readMetadata(path);
  if (before === undefined) {
    return { content: undefined, revision: { exists: false } };
  }

  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new FileChangedDuringReadError(path);
    }
    throw error;
  }

  const after = await readMetadata(path);
  if (after === undefined || !metadataEqual(before, after)) {
    throw new FileChangedDuringReadError(path);
  }

  return {
    content,
    revision: {
      ...after,
      exists: true,
      hash: createHash("sha256").update(content).digest("hex"),
    },
  };
}

export function revisionsEqual(left: FileContentRevision, right: FileContentRevision): boolean {
  if (!left.exists || !right.exists) {
    return left.exists === right.exists;
  }
  return left.hash === right.hash && metadataEqual(left, right);
}

interface FileMetadata {
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  gid: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  size: bigint;
  uid: bigint;
}

async function readMetadata(path: string): Promise<FileMetadata | undefined> {
  try {
    const value = await stat(path, { bigint: true });
    return {
      birthtimeNs: value.birthtimeNs,
      ctimeNs: value.ctimeNs,
      dev: value.dev,
      gid: value.gid,
      ino: value.ino,
      mode: value.mode,
      mtimeNs: value.mtimeNs,
      nlink: value.nlink,
      size: value.size,
      uid: value.uid,
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function metadataEqual(left: FileMetadata, right: FileMetadata): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  );
}
