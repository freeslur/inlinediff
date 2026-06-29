import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DiffSettingsAdapter {
  getBoolean(key: string): boolean | undefined;
  getWorkspaceFolderBoolean(key: string): boolean | undefined;
  setWorkspaceFolderBoolean(key: string, value: boolean | undefined): Promise<void>;
}

type DiffSettingsBackup = {
  renderSideBySide: boolean | null;
  codeLens: boolean | null;
};

const REQUIRED: ReadonlyArray<readonly [string, boolean]> = [
  ["diffEditor.renderSideBySide", false],
  ["diffEditor.codeLens", true],
];

const BACKUP_PATH = ".inlinediff/diff-settings-backup.json";

export function hasDiffSettingConflict(adapter: DiffSettingsAdapter): boolean {
  return REQUIRED.some(([key, target]) => adapter.getBoolean(key) !== target);
}

export async function applyDiffSettings(
  rootPath: string,
  adapter: DiffSettingsAdapter,
): Promise<void> {
  const backup: DiffSettingsBackup = {
    renderSideBySide: adapter.getWorkspaceFolderBoolean("diffEditor.renderSideBySide") ?? null,
    codeLens: adapter.getWorkspaceFolderBoolean("diffEditor.codeLens") ?? null,
  };
  await writeFile(join(rootPath, BACKUP_PATH), JSON.stringify(backup), "utf8");
  for (const [key, value] of REQUIRED) {
    await adapter.setWorkspaceFolderBoolean(key, value);
  }
}

export async function restoreDiffSettings(
  rootPath: string,
  adapter: DiffSettingsAdapter,
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(rootPath, BACKUP_PATH), "utf8"));
  } catch {
    return false;
  }
  // Treat a malformed backup as no usable backup rather than pushing garbage (or silently clearing
  // settings) into the workspace configuration.
  if (!isDiffSettingsBackup(parsed)) {
    return false;
  }
  const backup = parsed;
  await adapter.setWorkspaceFolderBoolean(
    "diffEditor.renderSideBySide",
    backup.renderSideBySide ?? undefined,
  );
  await adapter.setWorkspaceFolderBoolean("diffEditor.codeLens", backup.codeLens ?? undefined);
  return true;
}

function isDiffSettingsBackup(value: unknown): value is DiffSettingsBackup {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return isBooleanOrNull(candidate.renderSideBySide) && isBooleanOrNull(candidate.codeLens);
}

function isBooleanOrNull(value: unknown): value is boolean | null {
  return typeof value === "boolean" || value === null;
}
