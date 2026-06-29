import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDiffSettings,
  type DiffSettingsAdapter,
  hasDiffSettingConflict,
  restoreDiffSettings,
} from "../../src/diff-service/diff-settings.ts";

const testRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    testRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function makeRoot(): Promise<string> {
  const root = join(tmpdir(), `inlinediff-test-${randomUUID()}`);
  await mkdir(join(root, ".inlinediff"), { recursive: true });
  testRoots.push(root);
  return root;
}

type SetCall = { key: string; value: boolean | undefined };

function fakeAdapter({
  effective = new Map<string, boolean | undefined>(),
  workspaceFolder = new Map<string, boolean | undefined>(),
}: {
  effective?: Map<string, boolean | undefined>;
  workspaceFolder?: Map<string, boolean | undefined>;
} = {}): DiffSettingsAdapter & { setCalls: SetCall[] } {
  const setCalls: SetCall[] = [];
  return {
    getBoolean: (key) => effective.get(key),
    getWorkspaceFolderBoolean: (key) => workspaceFolder.get(key),
    setWorkspaceFolderBoolean: async (key, value) => {
      setCalls.push({ key, value });
    },
    setCalls,
  };
}

describe("hasDiffSettingConflict", () => {
  test("returns false when both settings match requirements", () => {
    const adapter = fakeAdapter({
      effective: new Map([
        ["diffEditor.renderSideBySide", false],
        ["diffEditor.codeLens", true],
      ]),
    });
    expect(hasDiffSettingConflict(adapter)).toBe(false);
  });

  test("returns true when renderSideBySide does not match", () => {
    const adapter = fakeAdapter({
      effective: new Map([
        ["diffEditor.renderSideBySide", true],
        ["diffEditor.codeLens", true],
      ]),
    });
    expect(hasDiffSettingConflict(adapter)).toBe(true);
  });

  test("returns true when codeLens does not match", () => {
    const adapter = fakeAdapter({
      effective: new Map([
        ["diffEditor.renderSideBySide", false],
        ["diffEditor.codeLens", false],
      ]),
    });
    expect(hasDiffSettingConflict(adapter)).toBe(true);
  });

  test("returns true when settings are absent (undefined = VS Code default)", () => {
    expect(hasDiffSettingConflict(fakeAdapter())).toBe(true);
  });
});

describe("applyDiffSettings", () => {
  test("writes required settings to workspace folder", async () => {
    const root = await makeRoot();
    const adapter = fakeAdapter();

    await applyDiffSettings(root, adapter);

    expect(adapter.setCalls).toContainEqual({ key: "diffEditor.renderSideBySide", value: false });
    expect(adapter.setCalls).toContainEqual({ key: "diffEditor.codeLens", value: true });
  });

  test("backs up null when workspace folder had no value for either setting", async () => {
    const root = await makeRoot();
    await applyDiffSettings(root, fakeAdapter());

    const backup = JSON.parse(
      await readFile(join(root, ".inlinediff/diff-settings-backup.json"), "utf8"),
    );
    expect(backup).toEqual({ renderSideBySide: null, codeLens: null });
  });

  test("backs up existing workspace folder values before applying", async () => {
    const root = await makeRoot();
    const adapter = fakeAdapter({
      workspaceFolder: new Map([
        ["diffEditor.renderSideBySide", true],
        ["diffEditor.codeLens", false],
      ]),
    });

    await applyDiffSettings(root, adapter);

    const backup = JSON.parse(
      await readFile(join(root, ".inlinediff/diff-settings-backup.json"), "utf8"),
    );
    expect(backup).toEqual({ renderSideBySide: true, codeLens: false });
  });

  test("overwrites existing backup with fresh workspace folder values", async () => {
    const root = await makeRoot();
    await applyDiffSettings(
      root,
      fakeAdapter({
        workspaceFolder: new Map([["diffEditor.renderSideBySide", true]]),
      }),
    );
    await applyDiffSettings(root, fakeAdapter());

    const backup = JSON.parse(
      await readFile(join(root, ".inlinediff/diff-settings-backup.json"), "utf8"),
    );
    expect(backup).toEqual({ renderSideBySide: null, codeLens: null });
  });
});

describe("restoreDiffSettings", () => {
  test("restores previous values from backup and returns true", async () => {
    const root = await makeRoot();
    await applyDiffSettings(
      root,
      fakeAdapter({
        workspaceFolder: new Map([
          ["diffEditor.renderSideBySide", true],
          ["diffEditor.codeLens", false],
        ]),
      }),
    );

    const adapter = fakeAdapter();
    const restored = await restoreDiffSettings(root, adapter);

    expect(restored).toBe(true);
    expect(adapter.setCalls).toContainEqual({ key: "diffEditor.renderSideBySide", value: true });
    expect(adapter.setCalls).toContainEqual({ key: "diffEditor.codeLens", value: false });
  });

  test("passes undefined when backup recorded null (key was absent in workspace folder)", async () => {
    const root = await makeRoot();
    await applyDiffSettings(root, fakeAdapter());

    const adapter = fakeAdapter();
    await restoreDiffSettings(root, adapter);

    expect(adapter.setCalls).toContainEqual({
      key: "diffEditor.renderSideBySide",
      value: undefined,
    });
    expect(adapter.setCalls).toContainEqual({ key: "diffEditor.codeLens", value: undefined });
  });

  test("returns false and writes nothing when no backup exists", async () => {
    const root = await makeRoot();
    const adapter = fakeAdapter();

    const restored = await restoreDiffSettings(root, adapter);

    expect(restored).toBe(false);
    expect(adapter.setCalls).toHaveLength(0);
  });

  test("returns false and writes nothing when the backup is malformed", async () => {
    const root = await makeRoot();
    await writeFile(
      join(root, ".inlinediff/diff-settings-backup.json"),
      JSON.stringify({ renderSideBySide: "yes" }),
      "utf8",
    );
    const adapter = fakeAdapter();

    const restored = await restoreDiffSettings(root, adapter);

    expect(restored).toBe(false);
    expect(adapter.setCalls).toHaveLength(0);
  });
});
