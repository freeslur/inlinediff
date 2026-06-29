import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, openSync, watch } from "node:fs";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readBaselineFile } from "../../src/diff-service/baseline-store.ts";
import { acceptFile } from "../../src/diff-service/file-actions.ts";
import { runGitRepository } from "../../src/diff-service/git-command.ts";
import { tryClaimInitializationStore } from "../../src/diff-service/initialization-store.ts";
import {
  findInitializableProjectRoots,
  initializeProject,
  reinitializeProject,
} from "../../src/diff-service/project-initializer.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-init-test-"));
  temporaryDirectories.push(root);
  return root;
}

describe("initializeProject", () => {
  test("only the successful initialization-store claimant can clean it up", async () => {
    const root = await createProject();
    const storePath = join(root, ".inlinediff");

    const owner = await tryClaimInitializationStore(storePath);
    const other = await tryClaimInitializationStore(storePath);
    await writeFile(join(storePath, "owner-marker"), "keep", "utf8");

    expect(owner).toBeDefined();
    expect(other).toBeUndefined();
    expect(await readFile(join(storePath, "owner-marker"), "utf8")).toBe("keep");
  });

  test("finds only roots without an existing inline diff store", async () => {
    const initialized = await createProject();
    const uninitialized = await createProject();
    await Bun.write(join(initialized, ".inlinediff", "marker"), "");

    expect(await findInitializableProjectRoots([initialized, uninitialized])).toEqual([
      uninitialized,
    ]);
  });

  test("creates an internal Git repository whose index is the accepted baseline", async () => {
    const root = await createProject();
    await writeFile(join(root, "example.ts"), "const value = 1;\n", "utf8");

    const storeId = await initializeProject(root);

    expect(await readBaselineFile(root, "example.ts")).toEqual(Buffer.from("const value = 1;\n"));
    expect((await stat(join(root, ".inlinediff", "repository", "index"))).isFile()).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".inlinediff", "project.json"), "utf8"))).toEqual({
      createdBy: "inlinediff",
      rootPath: root,
      schemaVersion: 1,
      storeId,
    });
    expect(typeof storeId).toBe("string");
    expect(storeId.length).toBeGreaterThan(0);
    await expect(stat(join(root, ".inlinediff", "baseline"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, ".inlinediff", "manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not add structural exclusions or binary files to the baseline", async () => {
    const root = await createProject();
    await Bun.write(join(root, "node_modules", "package", "index.js"), "dependency");
    await Bun.write(join(root, "dist", "output.js"), "output");
    await writeFile(join(root, "binary.bin"), Buffer.from([0x00, 0xff]));

    await initializeProject(root);

    // node_modules/dist are excluded by the default .diffignore template, so they are simply
    // absent from the baseline (no longer hard-rejected at the path layer).
    expect(await readBaselineFile(root, "node_modules/package/index.js")).toBeUndefined();
    expect(await readBaselineFile(root, "dist/output.js")).toBeUndefined();
    expect(await readBaselineFile(root, "binary.bin")).toBeUndefined();
  });

  test("does not add oversized text files to the baseline", async () => {
    const root = await createProject();
    await writeFile(join(root, "oversized.ts"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

    await initializeProject(root);

    expect(await readBaselineFile(root, "oversized.ts")).toBeUndefined();
  });

  test("stores text bytes without applying worktree attributes or ignore rules", async () => {
    const root = await createProject();
    const legacyText = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, ".gitattributes"), "*.txt text eol=crlf\n", "utf8");
    await writeFile(join(root, "ignored.txt"), legacyText);

    await initializeProject(root);

    expect(await readBaselineFile(root, "ignored.txt")).toEqual(legacyText);
    expect(await readFile(join(root, "ignored.txt"))).toEqual(legacyText);
  });

  test("uses root .diffignore rules during initialization while tracking .diffignore itself", async () => {
    const root = await createProject();
    await writeFile(join(root, ".diffignore"), "*.log\n!important.log\n.diffignore\n", "utf8");
    await writeFile(join(root, "ignored.log"), "ignored\n", "utf8");
    await writeFile(join(root, "important.log"), "important\n", "utf8");

    await initializeProject(root);

    expect(await readBaselineFile(root, "ignored.log")).toBeUndefined();
    expect(await readBaselineFile(root, "important.log")).toEqual(Buffer.from("important\n"));
    expect(await readBaselineFile(root, ".diffignore")).toEqual(
      Buffer.from("*.log\n!important.log\n.diffignore\n"),
    );
  });

  test("stages source files inside a nested inline diff project's folder", async () => {
    const root = await createProject();
    await Bun.write(join(root, "parent.ts"), "parent");
    await Bun.write(join(root, "nested", ".inlinediff", "marker"), "");
    await Bun.write(join(root, "nested", "nested.ts"), "nested");

    await initializeProject(root);

    expect(await readBaselineFile(root, "parent.ts")).toEqual(Buffer.from("parent"));
    expect(await readBaselineFile(root, "nested/nested.ts")).toEqual(Buffer.from("nested"));
  });

  test("never modifies an existing user Git repository", async () => {
    const root = await createProject();
    await runGitRepository(join(root, ".git"), root, ["init"]);
    await writeFile(join(root, "example.ts"), "before\n", "utf8");
    await runGitRepository(join(root, ".git"), root, ["add", "--", "example.ts"]);
    const userIndex = await readFile(join(root, ".git", "index"));

    await initializeProject(root);
    await writeFile(join(root, "example.ts"), "after\n", "utf8");
    await acceptFile(root, "example.ts");

    expect(await readFile(join(root, ".git", "index"))).toEqual(userIndex);
  });

  test("refuses to overwrite an existing inline diff store", async () => {
    const root = await createProject();
    await Bun.write(join(root, ".inlinediff", "marker"), "");

    await expect(initializeProject(root)).rejects.toThrow(".inlinediff already exists");
  });

  test("reinitializes an existing inline diff store only when explicitly requested", async () => {
    const root = await createProject();
    await Bun.write(join(root, ".inlinediff", "marker"), "untrusted");
    await writeFile(join(root, "example.ts"), "trusted baseline\n", "utf8");

    const storeId = await reinitializeProject(root);

    expect(JSON.parse(await readFile(join(root, ".inlinediff", "project.json"), "utf8"))).toEqual({
      createdBy: "inlinediff",
      rootPath: root,
      schemaVersion: 1,
      storeId,
    });
    expect(await readBaselineFile(root, "example.ts")).toEqual(Buffer.from("trusted baseline\n"));
    await expect(stat(join(root, ".inlinediff", "marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("serializes concurrent initialization attempts", async () => {
    const root = await createProject();
    await writeFile(join(root, "example.ts"), "text\n", "utf8");

    const results = await Promise.allSettled([initializeProject(root), initializeProject(root)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: {
        message: ".inlinediff already exists",
      },
    });
    expect(await readBaselineFile(root, "example.ts")).toEqual(Buffer.from("text\n"));
  });

  test("does not stage a file reached through a directory symlink into the baseline", async () => {
    const root = await createProject();
    const outside = await mkdtemp(join(tmpdir(), "inlinediff-init-outside-test-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "outside.ts"), "secret", "utf8");
    await writeFile(join(root, "real.ts"), "real\n", "utf8");
    await symlink(outside, join(root, "linked"), "junction");

    await initializeProject(root);

    expect(await readBaselineFile(root, "linked/outside.ts")).toBeUndefined();
    // A regular file is still staged, so the exclusion is specific to the symlinked path.
    expect(await readBaselineFile(root, "real.ts")).toEqual(Buffer.from("real\n"));
  });

  test("does not delete a store created by another initializing process", async () => {
    const root = await createProject();
    const gatePath = join(root, "start-initialization");
    for (let index = 0; index < 100; index += 1) {
      await writeFile(join(root, `file-${index}.ts`), `text-${index}\n`, "utf8");
    }
    const processes = Array.from({ length: 4 }, () => runInitializationProcess(root, gatePath));

    await Bun.sleep(50);
    await writeFile(gatePath, "start", "utf8");
    const exitCodes = await Promise.all(processes);

    expect(exitCodes.filter((code) => code === 0)).toHaveLength(1);
    expect(await readBaselineFile(root, "file-0.ts")).toEqual(Buffer.from("text-0\n"));
  });

  test.skipIf(platform() !== "win32")(
    "does not rename a temporary top-level store that workspace tools can lock",
    async () => {
      const root = await createProject();
      for (let index = 0; index < 100; index += 1) {
        await writeFile(join(root, `file-${index}.ts`), `text-${index}\n`, "utf8");
      }
      let lockedFile: number | undefined;
      const watcher = watch(root, (_, filename) => {
        if (
          lockedFile === undefined &&
          filename?.toString().startsWith(".inlinediff-initializing-")
        ) {
          try {
            lockedFile = openSync(join(root, filename.toString(), "workspace-tool.lock"), "w");
          } catch {
            // The directory may disappear between the watch event and opening the file.
          }
        }
      });

      try {
        await initializeProject(root);
      } finally {
        watcher.close();
        if (lockedFile !== undefined) {
          closeSync(lockedFile);
        }
      }

      expect(await readBaselineFile(root, "file-0.ts")).toEqual(Buffer.from("text-0\n"));
    },
    15_000,
  );
});

function runInitializationProcess(rootPath: string, gatePath: string): Promise<number | null> {
  const initializerUrl = pathToFileURL(
    join(process.cwd(), "src", "diff-service", "project-initializer.ts"),
  ).href;
  const script = `
    import { initializeProject } from ${JSON.stringify(initializerUrl)};
    while (!(await Bun.file(${JSON.stringify(gatePath)}).exists())) {
      await Bun.sleep(1);
    }
    try {
      await initializeProject(${JSON.stringify(rootPath)});
      process.exit(0);
    } catch {
      process.exit(2);
    }
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["-e", script], { windowsHide: true });
    child.on("error", reject);
    child.on("close", resolvePromise);
  });
}
