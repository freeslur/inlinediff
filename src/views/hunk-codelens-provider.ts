import * as vscode from "vscode";
import { type DiffHunk, readFileHunks } from "../diff-service/hunk-engine.ts";
import { ProjectOperationState } from "../diff-service/project-operation-state.ts";
import { isMissingPathError } from "../errors/fs-errors.ts";
import {
  createHunkCodeLensEntries,
  createHunkCodeLensPosition,
  hunkCodeLensTitles,
} from "./hunk-codelens-model.ts";
import {
  type InlineDiffDocumentContext,
  InlineDiffEditorRegistry,
  type InlineDiffUri,
} from "./inline-diff-editor-registry.ts";
import { KeptHunkStore } from "./kept-hunk-store.ts";

export interface HunkCommandArguments {
  hunkId: string;
  relativePath: string;
  rootPath: string;
}

interface HunkCodeLensProviderDependencies {
  readonly isChanging: (rootPath: string, relativePath: string) => boolean;
  readonly keptHunkStore: KeptHunkStore;
  readonly readHunks: (rootPath: string, relativePath: string) => Promise<DiffHunk[]>;
  readonly registry: {
    resolveDocument(uri: InlineDiffUri): InlineDiffDocumentContext | undefined;
  };
}

interface HunkCodeLensDocument {
  readonly isDirty: boolean;
  readonly lineCount: number;
  readonly uri: InlineDiffUri;
  lineAt(line: number): { readonly range: { readonly end: { readonly character: number } } };
}

const defaultDependencies: HunkCodeLensProviderDependencies = {
  isChanging: () => false,
  keptHunkStore: new KeptHunkStore(),
  readHunks: readFileHunks,
  registry: new InlineDiffEditorRegistry(),
};

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  readonly #onDidChangeCodeLenses = new vscode.EventEmitter<undefined>();
  readonly #dependencies: HunkCodeLensProviderDependencies;

  readonly onDidChangeCodeLenses = this.#onDidChangeCodeLenses.event;

  constructor(
    private readonly operationState = new ProjectOperationState(),
    dependencies: Partial<HunkCodeLensProviderDependencies> = {},
  ) {
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async provideCodeLenses(document: HunkCodeLensDocument): Promise<vscode.CodeLens[]> {
    if (document.isDirty) {
      return [];
    }

    const context = this.#dependencies.registry.resolveDocument(document.uri);
    if (context === undefined) {
      return [];
    }
    const { relativePath, rootPath } = context;
    if (this.#dependencies.isChanging(rootPath, relativePath)) {
      return [];
    }
    try {
      const hunks = await this.#dependencies.readHunks(rootPath, relativePath);
      this.#dependencies.keptHunkStore.retainHunks(
        rootPath,
        relativePath,
        new Set(hunks.map((hunk) => hunk.id)),
      );
      const entries = createHunkCodeLensEntries(hunks, document.lineCount);

      return entries.flatMap((entry) => {
        const { hunkId, line } = entry;
        if (this.operationState.isPendingHunk(rootPath, relativePath, hunkId)) {
          return [];
        }
        const position = createHunkCodeLensPosition(
          entry,
          document.lineCount,
          line >= document.lineCount ? 0 : document.lineAt(line).range.end.character,
        );
        const range = new vscode.Range(
          position.line,
          position.character,
          position.line,
          position.character,
        );
        const arguments_: HunkCommandArguments = {
          hunkId,
          relativePath,
          rootPath,
        };
        return [
          new vscode.CodeLens(range, {
            arguments: [arguments_],
            command: "inlinediff.acceptHunk",
            title: hunkCodeLensTitles.accept,
          }),
          new vscode.CodeLens(range, {
            arguments: [arguments_],
            command: "inlinediff.rejectHunk",
            title: hunkCodeLensTitles.reject,
          }),
          new vscode.CodeLens(range, {
            arguments: [arguments_],
            command: "inlinediff.toggleKeepHunk",
            title: this.#dependencies.keptHunkStore.isKept(rootPath, relativePath, hunkId)
              ? hunkCodeLensTitles.unkeep
              : hunkCodeLensTitles.keep,
          }),
        ];
      });
    } catch (error) {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    }
  }

  refresh(): void {
    this.#onDidChangeCodeLenses.fire(undefined);
  }
}
