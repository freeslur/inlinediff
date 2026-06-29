import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { InvalidProjectPathError, resolveSafeProjectPath } from "../diff-service/project-path.ts";
import { decodeTextContent } from "../diff-service/text-content.ts";
import { isMissingPathError } from "../errors/fs-errors.ts";

const currentScheme = "inlinediff-current";

export class CurrentContentProvider implements vscode.TextDocumentContentProvider {
  readonly #onDidChange = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.#onDidChange.event;

  // The root is taken from the caller-controlled URI, so a crafted URI could otherwise read any
  // file under an arbitrary root. Only serve roots the extension actually manages (trusted stores).
  constructor(private readonly isRootTrusted: (rootPath: string) => Promise<boolean>) {}

  createCurrentUri(rootUri: vscode.Uri, relativePath: string): vscode.Uri {
    return vscode.Uri.from({
      path: `/${relativePath}`,
      query: `root=${encodeURIComponent(rootUri.fsPath)}`,
      scheme: currentScheme,
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parameters = new URLSearchParams(uri.query);
    const rootPath = parameters.get("root");
    if (rootPath === null) {
      throw new Error("Current URI does not contain a project root.");
    }
    if (!(await this.isRootTrusted(rootPath))) {
      return "";
    }
    const relativePath = uri.path.replace(/^\/+/, "");
    try {
      const buffer = await readFile(await resolveSafeProjectPath(rootPath, relativePath));
      return decodeTextContent(buffer);
    } catch (error) {
      // A missing file or a path rejected as unsafe (e.g. reached through a symlink) shows as
      // empty content rather than leaking outside data or surfacing an error in the diff view.
      if (isMissingPathError(error) || error instanceof InvalidProjectPathError) {
        return "";
      }
      throw error;
    }
  }

  refresh(uri: vscode.Uri): void {
    this.#onDidChange.fire(uri);
  }
}

export const currentContentScheme = currentScheme;
