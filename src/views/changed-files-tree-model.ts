import { basename } from "node:path";
import type { ChangedFileEntry } from "./changed-files-model.ts";

export interface ProjectFiles {
  files: ChangedFileEntry[];
  label: string;
  rootPath: string;
}

interface ProjectFilesInput {
  files: readonly ChangedFileEntry[];
  rootPath: string;
}

export function groupChangedFilesByProject(projects: readonly ProjectFilesInput[]): ProjectFiles[] {
  return projects
    .map(({ files, rootPath }) => ({
      files: [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
      label: basename(rootPath),
      rootPath,
    }))
    .filter((project) => project.files.length > 0)
    .sort((left, right) => left.rootPath.localeCompare(right.rootPath));
}
