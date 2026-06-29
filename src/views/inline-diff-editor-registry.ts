import { platform } from "node:os";
import { resolve } from "node:path";
import { normalizeRelativePath, resolveProjectPath } from "../diff-service/project-path.ts";

export interface InlineDiffUri {
  readonly fsPath: string;
  readonly path: string;
  readonly query: string;
  readonly scheme: string;
  toString(): string;
}

export interface InlineDiffDocumentContext {
  readonly relativePath: string;
  readonly rootPath: string;
}

export interface InlineDiffEditorContext extends InlineDiffDocumentContext {
  readonly baselineUri: InlineDiffUri;
  readonly modifiedUri: InlineDiffUri;
}

export class InlineDiffEditorRegistry {
  readonly #contexts = new Map<string, InlineDiffEditorContext>();
  readonly #uriToContextKey = new Map<string, string>();

  register(context: InlineDiffEditorContext): void {
    const key = contextKey(context.rootPath, context.relativePath);
    const registered = {
      ...context,
      relativePath: normalizeRelativePath(context.relativePath),
    };
    this.#contexts.set(key, registered);
    this.#uriToContextKey.set(uriKey(context.baselineUri), key);
    this.#uriToContextKey.set(uriKey(context.modifiedUri), key);
  }

  unregisterDocument(uri: InlineDiffUri): void {
    const key = this.#uriToContextKey.get(uriKey(uri));
    if (key === undefined) {
      return;
    }
    const context = this.#contexts.get(key);
    if (context !== undefined) {
      this.#uriToContextKey.delete(uriKey(context.baselineUri));
      this.#uriToContextKey.delete(uriKey(context.modifiedUri));
    }
    this.#contexts.delete(key);
  }

  resolveDocument(uri: InlineDiffUri): InlineDiffDocumentContext | undefined {
    const key = this.#uriToContextKey.get(uriKey(uri));
    if (key === undefined) {
      return undefined;
    }
    const context = this.#contexts.get(key);
    if (context === undefined) {
      return undefined;
    }
    return {
      relativePath: context.relativePath,
      rootPath: context.rootPath,
    };
  }
}

function contextKey(rootPath: string, relativePath: string): string {
  resolveProjectPath(rootPath, relativePath);
  const key = `${resolve(rootPath)}\0${normalizeRelativePath(relativePath)}`;
  return platform() === "win32" ? key.toLowerCase() : key;
}

function uriKey(uri: InlineDiffUri): string {
  const key = uri.toString();
  return platform() === "win32" ? key.toLowerCase() : key;
}
