import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaceStores } from "../../src/diff-service/project-discovery.ts";
import { initializeProject } from "../../src/diff-service/project-initializer.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-discovery-test-"));
  temporaryDirectories.push(root);
  return root;
}

async function projectRoots(workspaceRoots: readonly string[]): Promise<string[]> {
  return (await discoverWorkspaceStores(workspaceRoots)).projectRoots;
}

describe("project root discovery", () => {
  test("treats each opened folder with trusted metadata as a project root", async () => {
    const workspace = await createWorkspace();
    const projectA = join(workspace, "project-a");
    const projectB = join(workspace, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    await initializeProject(projectA);
    await initializeProject(projectB);

    expect(await projectRoots([projectA, projectB])).toEqual([projectA, projectB]);
  });

  test("ignores an opened folder without an inline diff store", async () => {
    const workspace = await createWorkspace();

    expect(await discoverWorkspaceStores([workspace])).toEqual({
      projectRoots: [],
      storeRoots: [],
    });
  });

  test("reports a store without trusted metadata as a store but not a project", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, ".inlinediff", "repository"), { recursive: true });

    expect(await discoverWorkspaceStores([workspace])).toEqual({
      projectRoots: [],
      storeRoots: [workspace],
    });
  });

  test("ignores a store with malformed metadata", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, ".inlinediff", "repository"), { recursive: true });
    await writeFile(join(workspace, ".inlinediff", "project.json"), "{", "utf8");

    expect(await projectRoots([workspace])).toEqual([]);
  });

  test("ignores a store with unsupported schema metadata", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, ".inlinediff", "repository"), { recursive: true });
    await writeFile(
      join(workspace, ".inlinediff", "project.json"),
      JSON.stringify({
        createdBy: "inlinediff",
        rootPath: workspace,
        schemaVersion: 999,
        storeId: "future-store",
      }),
      "utf8",
    );

    expect(await projectRoots([workspace])).toEqual([]);
  });

  test("ignores trusted metadata copied from another project root", async () => {
    const workspace = await createWorkspace();
    const source = join(workspace, "source");
    const downloaded = join(workspace, "downloaded");
    await mkdir(source, { recursive: true });
    await mkdir(join(downloaded, ".inlinediff", "repository"), { recursive: true });
    await initializeProject(source);
    await copyFile(
      join(source, ".inlinediff", "project.json"),
      join(downloaded, ".inlinediff", "project.json"),
    );

    expect(await projectRoots([source, downloaded])).toEqual([source]);
  });

  test("does not descend into a nested store; it is discovered only when opened directly", async () => {
    const root = await createWorkspace();
    const nested = join(root, "nested");
    await mkdir(nested, { recursive: true });
    await initializeProject(root);
    await initializeProject(nested);

    // Opening only the outer folder never surfaces the nested store as its own project.
    expect(await projectRoots([root])).toEqual([root]);
    // Opening both (e.g. a multi-root workspace) discovers each as an independent root.
    expect(await projectRoots([root, nested])).toEqual([root, nested]);
  });

  test("deduplicates repeated workspace folders", async () => {
    const project = await createWorkspace();
    await initializeProject(project);

    expect(await projectRoots([project, project])).toEqual([project]);
  });
});
