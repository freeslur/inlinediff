import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaceStores } from "../src/diff-service/project-discovery.ts";
import { initializeProject } from "../src/diff-service/project-initializer.ts";
import { readProjectMetadata } from "../src/diff-service/project-metadata.ts";
import {
  filterTrustedProjectRoots,
  filterUntrustedStoreRoots,
  type TrustedStoreStorage,
  trustProjectStore,
} from "../src/project-trust.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("project trust", () => {
  test("blocks an existing store until its store id is trusted locally", async () => {
    const storage = new MemoryTrustStorage();
    const root = await createWorkspace();
    const storeId = await initializeProject(root);

    expect(await trustedProjectRoots(root, storage)).toEqual([]);
    expect(await untrustedStoreRoots(root, storage)).toEqual([root]);

    await trustProjectStore(storage, root, storeId);

    expect(await trustedProjectRoots(root, storage)).toEqual([root]);
    expect(await untrustedStoreRoots(root, storage)).toEqual([]);
  });

  test("blocks a store when the local trust record has a different store id", async () => {
    const storage = new MemoryTrustStorage();
    const root = await createWorkspace();
    await initializeProject(root);
    await trustProjectStore(storage, root, "different-store-id");

    expect(await trustedProjectRoots(root, storage)).toEqual([]);
    expect(await untrustedStoreRoots(root, storage)).toEqual([root]);
  });

  test("treats stores without reusable metadata as untrusted", async () => {
    const storage = new MemoryTrustStorage();
    const root = await createWorkspace();
    await mkdir(join(root, ".inlinediff", "repository"), { recursive: true });

    expect(await readProjectMetadata(root)).toBeUndefined();
    expect(await trustedProjectRoots(root, storage)).toEqual([]);
    expect(await untrustedStoreRoots(root, storage)).toEqual([root]);
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-project-trust-test-"));
  temporaryDirectories.push(root);
  return root;
}

// Mirrors the production trusted-root path: one workspace walk feeds the trusted filter.
async function trustedProjectRoots(root: string, storage: TrustedStoreStorage): Promise<string[]> {
  return filterTrustedProjectRoots((await discoverWorkspaceStores([root])).projectRoots, storage);
}

// Mirrors the production untrusted-store path: one workspace walk feeds the untrusted filter.
async function untrustedStoreRoots(root: string, storage: TrustedStoreStorage): Promise<string[]> {
  return filterUntrustedStoreRoots(
    (await discoverWorkspaceStores([root])).storeRoots,
    storage,
    new Set(),
  );
}

class MemoryTrustStorage implements TrustedStoreStorage {
  readonly #values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.#values.get(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    this.#values.set(key, value);
  }
}
