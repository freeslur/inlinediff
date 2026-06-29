import type { FileChangeKind } from "../diff-service/change-kind.ts";
import type { ScannedFile } from "../diff-service/project-scanner.ts";

export interface ChangedFileEntry {
  description: string;
  kind: Exclude<FileChangeKind, "clean">;
  relativePath: string;
}

const descriptions: Record<ChangedFileEntry["kind"], string> = {
  added: "A",
  "binary-modified": "Binary",
  deleted: "D",
  modified: "M",
};

export function createChangedFileEntries(files: readonly ScannedFile[]): ChangedFileEntry[] {
  return files
    .filter((file): file is ScannedFile & { kind: ChangedFileEntry["kind"] } =>
      ["added", "binary-modified", "deleted", "modified"].includes(file.kind),
    )
    .map((file) => ({
      description: descriptions[file.kind],
      kind: file.kind,
      relativePath: file.relativePath,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function canOpenChangedFileDiff(file: ChangedFileEntry): boolean {
  return file.kind !== "binary-modified";
}
