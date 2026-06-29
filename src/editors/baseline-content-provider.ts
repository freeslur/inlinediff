import * as vscode from "vscode";
import { readBaselineFile } from "../diff-service/baseline-store.ts";
import { decodeTextContent } from "../diff-service/text-content.ts";

const baselineScheme = "inlinediff-baseline";

export class BaselineContentProvider implements vscode.TextDocumentContentProvider {
  readonly #onDidChange = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.#onDidChange.event;

  // The root is taken from the caller-controlled URI, so a crafted URI could otherwise read any
  // file under an arbitrary root. Only serve roots the extension actually manages (trusted stores).
  constructor(private readonly isRootTrusted: (rootPath: string) => Promise<boolean>) {}

  createBaselineUri(rootUri: vscode.Uri, relativePath: string): vscode.Uri {
    return vscode.Uri.from({
      path: `/${relativePath}`,
      query: `root=${encodeURIComponent(rootUri.fsPath)}`,
      scheme: baselineScheme,
    });
  }

  createEmptyUri(
    rootUri: vscode.Uri,
    relativePath: string,
    side: "modified" | "original",
  ): vscode.Uri {
    return vscode.Uri.from({
      path: `/${relativePath}`,
      query: `empty=true&side=${side}&root=${encodeURIComponent(rootUri.fsPath)}`,
      scheme: baselineScheme,
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parameters = new URLSearchParams(uri.query);
    if (parameters.get("empty") === "true") {
      return "";
    }

    const rootPath = parameters.get("root");
    if (rootPath === null) {
      throw new Error("Baseline URI does not contain a project root.");
    }
    if (!(await this.isRootTrusted(rootPath))) {
      return "";
    }

    const relativePath = uri.path.replace(/^\/+/, "");
    const content = await readBaselineFile(rootPath, relativePath);
    return content === undefined ? "" : decodeTextContent(content);
  }

  refresh(uri: vscode.Uri): void {
    this.#onDidChange.fire(uri);
  }
}

export const baselineContentScheme = baselineScheme;
