import { runProjectGit } from "./git-command.ts";
import { resolveProjectPath } from "./project-path.ts";

export async function readBaselineFile(
  rootPath: string,
  relativePath: string,
): Promise<Buffer | undefined> {
  resolveProjectPath(rootPath, relativePath);
  const { stdout } = await runProjectGit(rootPath, [
    "--literal-pathspecs",
    "ls-files",
    "--stage",
    "-z",
    "--",
    relativePath,
  ]);
  if (stdout.length === 0) {
    return undefined;
  }

  // The internal index never holds merge conflicts, so a path resolves to exactly one stage-0
  // entry. A second record (NUL before the end) or a non-zero stage means the index is corrupt;
  // refuse to trust an arbitrary blob as the baseline rather than silently restoring wrong content.
  if (stdout.indexOf(0x00) !== stdout.length - 1) {
    throw new Error(`Ambiguous Git index entry for: ${relativePath}`);
  }
  const tabIndex = stdout.indexOf(0x09);
  if (tabIndex < 0) {
    throw new Error(`Invalid Git index entry for: ${relativePath}`);
  }
  const [, objectId, stage] = stdout.subarray(0, tabIndex).toString("ascii").split(" ");
  if (objectId === undefined || stage !== "0") {
    throw new Error(`Invalid Git index entry for: ${relativePath}`);
  }
  return (await runProjectGit(rootPath, ["cat-file", "blob", objectId])).stdout;
}

export async function writeBaselineFile(
  rootPath: string,
  relativePath: string,
  content: Buffer,
): Promise<void> {
  resolveProjectPath(rootPath, relativePath);
  const { stdout } = await runProjectGit(rootPath, ["hash-object", "-w", "--stdin"], {
    input: content,
  });
  const objectId = stdout.toString("ascii").trim();
  if (objectId.length === 0) {
    throw new Error(`Invalid Git blob for: ${relativePath}`);
  }
  await runProjectGit(rootPath, [
    "update-index",
    "--add",
    "--cacheinfo",
    "100644",
    objectId,
    relativePath,
  ]);
}
