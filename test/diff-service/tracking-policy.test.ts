import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTrackableTextFile } from "../../src/diff-service/tracking-policy.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createFile(content: Uint8Array | string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-policy-test-"));
  temporaryDirectories.push(root);
  const path = join(root, "file");
  await writeFile(path, content);
  return path;
}

describe("isTrackableTextFile", () => {
  test("accepts text regardless of UTF-8 validity", async () => {
    const path = await createFile(Buffer.from([0x63, 0x61, 0x66, 0xe9]));

    expect(await isTrackableTextFile(path)).toBe(true);
  });

  test("excludes binary files and oversized text files", async () => {
    const binaryPath = await createFile(Buffer.from([0x00, 0xff]));
    const largeText = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    const largePath = await createFile(largeText);

    expect(await isTrackableTextFile(binaryPath)).toBe(false);
    expect(await isTrackableTextFile(largePath)).toBe(false);
  });
});
