import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProject } from "../src/diff-service/project-initializer.ts";
import { isProjectStoreTrusted, type TrustedStoreStorage } from "../src/project-trust.ts";
import {
  resolveUntrustedProjectStore,
  type UntrustedStoreChoice,
} from "../src/untrusted-store-resolution.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("resolveUntrustedProjectStore", () => {
  test("registers an existing store only after the user chooses reuse", async () => {
    const storage = new MemoryTrustStorage();
    const root = await createWorkspace();
    await initializeProject(root);

    const changed = await resolveUntrustedProjectStore({
      ignoredStoreKeys: new Set(),
      messages: new MemoryUntrustedStoreMessages("Reuse Existing"),
      rootPath: root,
      storage,
    });

    expect(changed).toBe(true);
    expect(await isProjectStoreTrusted(storage, root)).toBe(true);
  });

  test("reinitializes and trusts a store only after the user chooses reinitialize", async () => {
    const storage = new MemoryTrustStorage();
    const root = await createWorkspace();
    await initializeProject(root);
    await writeFile(join(root, ".inlinediff", "marker"), "remove me", "utf8");

    const changed = await resolveUntrustedProjectStore({
      ignoredStoreKeys: new Set(),
      messages: new MemoryUntrustedStoreMessages("Reinitialize"),
      rootPath: root,
      storage,
    });

    expect(changed).toBe(true);
    expect(await isProjectStoreTrusted(storage, root)).toBe(true);
    expect(await readFile(join(root, "project.ts"), "utf8")).toBe("baseline\n");
    await expect(stat(join(root, ".inlinediff", "marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("suppresses future prompts after the user chooses ignore", async () => {
    const storage = new MemoryTrustStorage();
    const root = await createWorkspace();
    await initializeProject(root);
    const ignoredStoreKeys = new Set<string>();

    const changed = await resolveUntrustedProjectStore({
      ignoredStoreKeys,
      messages: new MemoryUntrustedStoreMessages("Ignore"),
      rootPath: root,
      storage,
    });

    expect(changed).toBe(false);
    expect(ignoredStoreKeys.size).toBe(1);
    expect(await isProjectStoreTrusted(storage, root)).toBe(false);
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-untrusted-store-test-"));
  temporaryDirectories.push(root);
  await writeFile(join(root, "project.ts"), "baseline\n", "utf8");
  return root;
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

class MemoryUntrustedStoreMessages {
  constructor(readonly choice: UntrustedStoreChoice) {}

  async showErrorMessage(_message: string): Promise<void> {}

  async showInformationMessage(_message: string): Promise<void> {}

  async showWarningMessage(): Promise<UntrustedStoreChoice> {
    return this.choice;
  }
}
