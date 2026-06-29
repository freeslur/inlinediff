import { platform } from "node:os";
import { resolve } from "node:path";
import { readProjectMetadata } from "./diff-service/project-metadata.ts";

export interface TrustedStoreStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

const trustedStoresKey = "inlinediff.trustedStores.v1";

// Trust filter over precomputed project roots (from a shared workspace walk), no re-walk.
export async function filterTrustedProjectRoots(
  projectRoots: readonly string[],
  storage: TrustedStoreStorage,
): Promise<string[]> {
  const trustedRoots: string[] = [];
  for (const rootPath of projectRoots) {
    if (await isProjectStoreTrusted(storage, rootPath)) {
      trustedRoots.push(rootPath);
    }
  }
  return trustedRoots;
}

// Untrusted filter over precomputed store roots (from a shared workspace walk), no re-walk.
export async function filterUntrustedStoreRoots(
  storeRoots: readonly string[],
  storage: TrustedStoreStorage,
  ignoredStoreKeys: ReadonlySet<string>,
): Promise<string[]> {
  const untrustedRoots: string[] = [];
  for (const rootPath of storeRoots) {
    const key = projectTrustKey(rootPath);
    if (!ignoredStoreKeys.has(key) && !(await isProjectStoreTrusted(storage, rootPath))) {
      untrustedRoots.push(rootPath);
    }
  }
  return untrustedRoots;
}

export async function isProjectStoreTrusted(
  storage: TrustedStoreStorage,
  rootPath: string,
): Promise<boolean> {
  const metadata = await readProjectMetadata(rootPath);
  return (
    metadata !== undefined &&
    readTrustedStores(storage)[projectTrustKey(rootPath)] === metadata.storeId
  );
}

export async function trustProjectStore(
  storage: TrustedStoreStorage,
  rootPath: string,
  storeId: string,
): Promise<void> {
  await storage.update(trustedStoresKey, {
    ...readTrustedStores(storage),
    [projectTrustKey(rootPath)]: storeId,
  });
}

export function projectTrustKey(rootPath: string): string {
  const resolved = resolve(rootPath);
  return platform() === "win32" ? resolved.toLowerCase() : resolved;
}

function readTrustedStores(storage: TrustedStoreStorage): Record<string, string> {
  const value = storage.get(trustedStoresKey);
  if (!isStringRecord(value)) {
    return {};
  }
  return value;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}
