import { open, stat } from "node:fs/promises";
import { binaryDetectionSampleSize, isBinaryContent } from "./text-content.ts";

export const maxDiffableTextFileBytes = 2 * 1024 * 1024;

export function isTrackableTextContent(content: Uint8Array): boolean {
  if (content.length > maxDiffableTextFileBytes) {
    return false;
  }
  return !isBinaryContent(content.subarray(0, binaryDetectionSampleSize));
}

export async function isTrackableTextFile(path: string): Promise<boolean> {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    return false;
  }
  if (metadata.size > maxDiffableTextFileBytes) {
    return false;
  }

  const handle = await open(path, "r");
  try {
    const sample = Buffer.allocUnsafe(Math.min(metadata.size, binaryDetectionSampleSize));
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return isTrackableTextContent(sample.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function isOversizedTextFile(path: string): Promise<boolean> {
  const metadata = await stat(path);
  return metadata.isFile() && metadata.size > maxDiffableTextFileBytes;
}
